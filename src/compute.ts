import { formatUnits } from '@ethersproject/units';
// @ts-ignore
import { register } from '@snapshot-labs/checkpoint/dist/src/register';
import snapshotjs from '@snapshot-labs/snapshot.js';
import { Mutex } from 'async-mutex';
import { COMPUTE_DELAY_SECONDS, SCORE_API_URL } from './constants';
import { getSpace } from './hub';
import { Delegate, Governance } from '../.checkpoint/models';

const DECIMALS = 18;
const DELEGATION_STRATEGIES = [
  'delegation',
  'erc20-balance-of-delegation',
  'delegation-with-cap',
  'delegation-with-overrides'
];

const lastCompute = new Map<string, number>();
const mutex = new Mutex();

// This function is called everytime governance information is queried from GraphQL API.
// It receives array of governances that we want to update information about.
//
// Here we need to fetch data from delegate registry v1 and process it
// and format it to format that delegates-api exposes.
// https://github.com/snapshot-labs/delegates-api
// Then just store it in the database using Governance and Delegate models.
export async function compute(governances: string[]) {
  const release = await mutex.acquire();

  try {
    register.setCurrentBlock(register.getCurrentBlock() + 1n);

    for (const governance of governances) {
      console.log('computing', governance);

      const computedAt = lastCompute.get(governance) ?? 0;
      const now = Math.floor(Date.now() / 1000);
      if (now - computedAt < COMPUTE_DELAY_SECONDS) {
        console.log('ignoring because of recent compute');
        continue;
      }
      lastCompute.set(governance, now);

      const space = await getSpace(governance);
      const delegations = await snapshotjs.utils.getDelegatesBySpace(
        space.network,
        governance,
        'latest'
      );

      const delegatorCounter = {};
      for (const delegation of delegations) {
        if (!delegatorCounter[delegation.delegate]) {
          delegatorCounter[delegation.delegate] = 0;
        }

        delegatorCounter[delegation.delegate] += 1;
      }

      const delegationsMap = Object.fromEntries(
        delegations.map(d => [d.delegate, d])
      );
      const delegatesAddresses = Object.keys(delegationsMap);
      const uniqueDelegates = Object.values(delegationsMap);

      const strategies = space.strategies.filter(strategy =>
        DELEGATION_STRATEGIES.includes(strategy.name)
      );

      const scores = await snapshotjs.utils.getScores(
        governance,
        strategies,
        space.network,
        delegatesAddresses,
        'latest',
        `${SCORE_API_URL}/api/scores`
      );

      const delegates = uniqueDelegates.map(delegate => ({
        ...delegate,
        score: BigInt(
          Math.floor((scores[0][delegate.delegate] ?? 0) * 10 ** DECIMALS)
        )
      }));

      const sortedDelegates = delegates
        .filter(delegate => delegate.score > 0n)
        .sort((a, b) => (b.score > a.score ? 1 : -1));

      const totalVotes = sortedDelegates.reduce(
        (acc, delegate) => acc + delegate.score,
        0n
      );

      const governanceEntity = new Governance(governance);
      governanceEntity.currentDelegates = uniqueDelegates.length;
      governanceEntity.totalDelegates = uniqueDelegates.length;
      governanceEntity.delegatedVotesRaw = totalVotes.toString();
      governanceEntity.delegatedVotes = formatUnits(totalVotes, DECIMALS);
      await governanceEntity.save();

      for (const delegate of sortedDelegates) {
        const delegateEntity = new Delegate(
          `${governance}/${delegate.delegate}`
        );
        delegateEntity.governance = governance;
        delegateEntity.user = delegate.delegate;
        delegateEntity.delegatedVotesRaw = delegate.score.toString();
        delegateEntity.delegatedVotes = formatUnits(delegate.score, DECIMALS);
        delegateEntity.tokenHoldersRepresentedAmount =
          delegatorCounter[delegate.delegate];
        await delegateEntity.save();
      }

      console.log('finished compute', governance);
    }
  } catch (e) {
    console.error('compute error', e);
  } finally {
    release();
  }
}

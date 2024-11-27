import { formatUnits } from '@ethersproject/units';
import { register } from '@snapshot-labs/checkpoint/dist/src/register';
import snapshotjs from '@snapshot-labs/snapshot.js';
import { Mutex } from 'async-mutex';
import {
  NETWORK_COMPUTE_DELAY_SECONDS,
  SCORE_API_URL,
  SPACE_COMPUTE_DELAY_SECONDS
} from './constants';
import { getSpace, Space } from './hub';
import { Delegate, Governance } from '../.checkpoint/models';

type NetworkCache = {
  timestamp: number;
  data: Awaited<ReturnType<typeof snapshotjs.utils.getDelegatesBySpace>>;
};

const DECIMALS = 18;
const DELEGATION_STRATEGIES = [
  'delegation',
  'erc20-balance-of-delegation',
  'delegation-with-cap',
  'delegation-with-overrides',
  'with-delegation',
  'erc20-balance-of-with-delegation'
];

const networkDelegationsCache = new Map<string, NetworkCache>();
const lastSpaceCompute = new Map<string, number>();
const mutex = new Mutex();

async function getNetworkDelegations(network: string) {
  const cache = networkDelegationsCache.get(network);
  const now = Math.floor(Date.now() / 1000);

  if (cache && now - cache.timestamp < NETWORK_COMPUTE_DELAY_SECONDS) {
    return cache.data;
  }

  const delegations = await snapshotjs.utils.getDelegatesBySpace(
    network,
    null,
    'latest'
  );

  networkDelegationsCache.set(network, {
    timestamp: now,
    data: delegations
  });

  return delegations;
}

async function getScores(
  network: string,
  governance: string,
  strategies: Space['strategies'],
  delegatesAddresses: string[]
): Promise<Record<string, number>> {
  const chunks = delegatesAddresses.reduce((acc, address, i) => {
    const chunkIndex = Math.floor(i / 500);
    if (!acc[chunkIndex]) acc[chunkIndex] = [];
    acc[chunkIndex].push(address);
    return acc;
  }, [] as string[][]);

  let scores: Record<string, number> = {};
  for (const chunk of chunks) {
    const result = await snapshotjs.utils.getScores(
      governance,
      strategies,
      network,
      chunk,
      'latest',
      `${SCORE_API_URL}/api/scores`
    );

    const totalScores = result.reduce((acc, scores) => {
      for (const [delegate, score] of Object.entries(scores)) {
        acc[delegate] = (acc[delegate] ?? 0) + score;
      }
      return acc;
    }, {});

    scores = {
      ...scores,
      ...totalScores
    };
  }

  return scores;
}

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

      const computedAt = lastSpaceCompute.get(governance) ?? 0;
      const now = Math.floor(Date.now() / 1000);
      if (now - computedAt < SPACE_COMPUTE_DELAY_SECONDS) {
        console.log('ignoring because of recent compute');
        continue;
      }

      const space = await getSpace(governance);
      const delegations = await getNetworkDelegations(space.network);

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

      const scores = await getScores(
        space.network,
        governance,
        strategies,
        delegatesAddresses
      );

      const delegates = uniqueDelegates.map(delegate => ({
        ...delegate,
        score: BigInt(
          Math.floor((scores[delegate.delegate] ?? 0) * 10 ** DECIMALS)
        )
      }));

      const sortedDelegates = delegates
        .filter(delegate => delegate.score > 0n)
        .sort((a, b) => (b.score > a.score ? 1 : -1));

      const totalVotes = sortedDelegates.reduce(
        (acc, delegate) => acc + delegate.score,
        0n
      );

      let governanceEntity = await Governance.loadEntity(governance);
      if (!governanceEntity) governanceEntity = new Governance(governance);

      governanceEntity.currentDelegates = sortedDelegates.length;
      governanceEntity.totalDelegates = delegations.length;
      governanceEntity.delegatedVotesRaw = totalVotes.toString();
      governanceEntity.delegatedVotes = formatUnits(totalVotes, DECIMALS);
      await governanceEntity.save();

      for (const delegate of sortedDelegates) {
        const id = `${governance}/${delegate.delegate}`;
        let delegateEntity = await Delegate.loadEntity(id);
        if (!delegateEntity) delegateEntity = new Delegate(id);

        delegateEntity.governance = governance;
        delegateEntity.user = delegate.delegate;
        delegateEntity.delegatedVotesRaw = delegate.score.toString();
        delegateEntity.delegatedVotes = formatUnits(delegate.score, DECIMALS);
        delegateEntity.tokenHoldersRepresentedAmount =
          delegatorCounter[delegate.delegate];
        await delegateEntity.save();
      }

      lastSpaceCompute.set(governance, now);

      console.log('finished compute', governance);
    }
  } catch (e) {
    console.error('compute error', e);
  } finally {
    release();
  }
}

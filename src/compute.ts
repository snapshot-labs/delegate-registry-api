import { formatUnits } from '@ethersproject/units';
import { register } from '@snapshot-labs/checkpoint/dist/src/register';
import snapshotjs from '@snapshot-labs/snapshot.js';
import { Mutex } from 'async-mutex';
import { currentBlockTracker } from './checkpoint';
import {
  NETWORK_COMPUTE_DELAY_SECONDS,
  SCORE_API_URL,
  SPACE_COMPUTE_DELAY_SECONDS
} from './constants';
import {
  getCustomGovernanceDelegations,
  getOnchainScores
} from './custom-governances';
import { getSpace, Space } from './hub';
import { CustomGovernance, DelegateItem, Delegation } from './types';
import { Delegate, Governance } from '../.checkpoint/models';

type NetworkCache = {
  timestamp: number;
  data: Awaited<ReturnType<typeof snapshotjs.utils.getDelegatesBySpace>>;
};

const CUSTOM_GOVERNANCES: Record<string, CustomGovernance | undefined> = {
  apechain: {
    type: 'CUSTOM_GOVERNANCE',
    network: '33139',
    viewId: '',
    delegationRegistry: '0x2f9e24e272d343c1f833ee7f3c6d6abc689b0102',
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmb7myliieemg01v8928cd8rs/subgraphs/snapshot-apechain/0.0.1/gn'
  },
  curtis: {
    type: 'CUSTOM_GOVERNANCE',
    network: '33111',
    viewId: '',
    delegationRegistry: '0xdd6b74123b2ab93ad701320d3f8d1b92b4fa5202',
    subgraphUrl:
      'https://api.goldsky.com/api/public/project_cmb7myliieemg01v8928cd8rs/subgraphs/snapshot-curtis/0.0.1/gn'
  }
};

const DECIMALS = 18;
const DELEGATION_STRATEGIES = [
  'delegation',
  'erc20-balance-of-delegation',
  'delegation-with-cap',
  'delegation-with-overrides',
  'with-delegation',
  'erc20-balance-of-with-delegation',
  'spark-with-delegation'
];
const WHITELIST_DELEGATES_STRATEGIES = ['spark-with-delegation'];

const networkDelegationsCache = new Map<string, NetworkCache>();
const lastSpaceCompute = new Map<string, number>();
const mutex = new Mutex();

function getDelegationSpace(id: string) {
  if (id.includes(':')) {
    const [networkId, viewId] = id.split(':');

    if (CUSTOM_GOVERNANCES[networkId]) {
      return {
        ...CUSTOM_GOVERNANCES[networkId],
        viewId
      };
    }

    throw new Error(`Unknown custom governance ID: ${id}`);
  }

  return getSpace(id);
}

async function getDelegationsForNetworks(space: Space) {
  const strategies = space.strategies.filter(strategy =>
    DELEGATION_STRATEGIES.includes(strategy.name)
  );

  const delegationNetworks = Array.from(
    new Set(
      strategies.map(
        strategy =>
          strategy.params?.delegationNetwork ??
          strategy.network ??
          space.network
      )
    )
  );

  const now = Math.floor(Date.now() / 1000);
  let allDelegations: Delegation[] = [];

  for (const network of delegationNetworks) {
    const cache = networkDelegationsCache.get(network);
    if (cache && now - cache.timestamp < NETWORK_COMPUTE_DELAY_SECONDS) {
      allDelegations = allDelegations.concat(cache.data);
      continue;
    }

    const delegationsData = await snapshotjs.utils.getDelegatesBySpace(
      network,
      null,
      'latest'
    );

    const delegations = delegationsData.map(delegation => ({
      ...delegation,
      delegate: snapshotjs.utils.getFormattedAddress(
        delegation.delegate,
        'evm'
      ),
      delegator: snapshotjs.utils.getFormattedAddress(
        delegation.delegator,
        'evm'
      )
    }));

    networkDelegationsCache.set(network, {
      timestamp: now,
      data: delegations
    });

    allDelegations = allDelegations.concat(delegations);
  }

  return allDelegations;
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
    for (const governance of governances) {
      console.log('computing', governance);

      const computedAt = lastSpaceCompute.get(governance) ?? 0;
      const now = Math.floor(Date.now() / 1000);
      if (now - computedAt < SPACE_COMPUTE_DELAY_SECONDS) {
        console.log('ignoring because of recent compute');
        continue;
      }
      const current = await currentBlockTracker.increaseCurrentBlock();
      const space = await getDelegationSpace(governance);
      const isCustomGovernance = 'type' in space;

      let allDelegations = isCustomGovernance
        ? await getCustomGovernanceDelegations(space)
        : await getDelegationsForNetworks(space);

      let whitelistedAddresses = isCustomGovernance
        ? []
        : space.strategies
            .filter(
              strategy =>
                WHITELIST_DELEGATES_STRATEGIES.includes(strategy.name) &&
                strategy.params?.whitelistedDelegates?.length > 0
            )
            .flatMap(strategy => strategy.params.whitelistedDelegates)
            .map(address =>
              snapshotjs.utils.getFormattedAddress(address, 'evm')
            );

      if (whitelistedAddresses.length) {
        whitelistedAddresses = [...new Set(whitelistedAddresses)];
        allDelegations = allDelegations.filter(delegation =>
          whitelistedAddresses.includes(delegation.delegate)
        );
      }

      const delegations = allDelegations.filter(delegation =>
        ['', governance].includes(delegation.space)
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

      let delegates: DelegateItem[] = [];
      if (isCustomGovernance) {
        const scores = await getOnchainScores({
          space,
          delegations
        });

        delegates = uniqueDelegates.map(delegate => ({
          ...delegate,
          score: scores[delegate.delegate] ?? 0n
        }));
      } else {
        const strategies = space.strategies.filter(strategy =>
          DELEGATION_STRATEGIES.includes(strategy.name)
        );

        const scores = await getScores(
          space.network,
          governance,
          strategies,
          delegatesAddresses
        );

        delegates = uniqueDelegates.map(delegate => ({
          ...delegate,
          score: BigInt(
            Math.floor((scores[delegate.delegate] ?? 0) * 10 ** DECIMALS)
          )
        }));
      }

      // Keep addresses with non-zero scores and
      // Add missing whitelisted delegates with zero scores and sort
      const existingDelegates = new Set(delegates.map(d => d.delegate));
      const sortedDelegates = [
        ...delegates.filter(delegate => delegate.score > 0n),
        ...whitelistedAddresses
          .filter(address => !existingDelegates.has(address))
          .map(address => ({
            delegate: address,
            delegator: '',
            space: governance,
            timestamp: 0,
            score: 0n
          }))
      ].sort((a, b) => (b.score > a.score ? 1 : -1));

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

      // NOTE: This needs to be verified in case we upgrade Checkpoint
      const knex = register.getKnex();
      await knex
        .table(Delegate.tableName)
        .andWhere('governance', governance)
        .andWhereRaw('upper_inf(block_range)')
        .update({
          block_range: knex.raw('int8range(lower(block_range), ?)', [current])
        });

      for (const delegate of sortedDelegates) {
        const id = `${governance}/${delegate.delegate}`;
        let delegateEntity = await Delegate.loadEntity(id);
        if (!delegateEntity) delegateEntity = new Delegate(id);

        delegateEntity.governance = governance;
        delegateEntity.user = delegate.delegate;
        delegateEntity.delegatedVotesRaw = delegate.score.toString();
        delegateEntity.delegatedVotes = formatUnits(delegate.score, DECIMALS);
        delegateEntity.tokenHoldersRepresentedAmount =
          delegatorCounter[delegate.delegate] || 0;
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

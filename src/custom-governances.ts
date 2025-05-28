import { StaticJsonRpcProvider } from '@ethersproject/providers';
import snapshotjs from '@snapshot-labs/snapshot.js';
import { CustomGovernance, Delegation } from './types';

const PAGE_SIZE = 1000;

function getProvider(chainId: string) {
  return new StaticJsonRpcProvider(
    `https://rpc.snapshot.org/${chainId}`,
    Number(chainId)
  );
}

export async function getOnchainScores(
  chainId: string,
  delegations: Delegation[]
) {
  const provider = getProvider(chainId);

  const scores: Record<string, bigint> = {};

  for (const delegation of delegations) {
    const { delegator, delegate } = delegation;

    if (!scores[delegate]) {
      const balance = await provider.getBalance(delegate);
      scores[delegate] = balance.toBigInt();
    }

    const balance = await provider.getBalance(delegator);
    scores[delegate] += balance.toBigInt();
  }

  return scores;
}

// Adapted from https://github.com/snapshot-labs/snapshot.js/blob/55e4c1c7a33ce28dd465c42c026814047c39bb3c/src/utils/delegation.ts#L14
// But uses space_raw instead of space_in
export async function getCustomGovernanceDelegations(space: CustomGovernance) {
  let pivot = 0;
  const result = new Map<string, Delegation>();

  while (true) {
    const newResults = await fetchData({
      url: space.subgraphUrl,
      spaceRaw: space.viewId,
      pivot,
      snapshot: 'latest'
    });

    if (checkAllDuplicates(newResults)) {
      throw new Error('Unable to paginate delegation');
    }

    newResults.forEach(delegation => {
      concatUniqueDelegation(result, delegation);
      pivot = delegation.timestamp;
    });

    if (newResults.length < PAGE_SIZE) break;
  }

  return [...result.values()];
}

function checkAllDuplicates(delegations: Delegation[]) {
  return (
    delegations.length === PAGE_SIZE &&
    delegations[0].timestamp === delegations[delegations.length - 1].timestamp
  );
}

function delegationKey(delegation: Delegation) {
  return `${delegation.delegator}-${delegation.delegate}-${delegation.space}`;
}

function concatUniqueDelegation(
  result: Map<string, Delegation>,
  delegation: Delegation
): void {
  const key = delegationKey(delegation);
  if (!result.has(key)) {
    result.set(key, delegation);
  }
}

async function fetchData({
  url,
  spaceRaw,
  pivot,
  snapshot
}: {
  url: string;
  spaceRaw: string;
  pivot: number;
  snapshot: string | number;
}): Promise<Delegation[]> {
  const params: any = {
    delegations: {
      __args: {
        where: {
          timestamp_gte: pivot,
          space_raw: spaceRaw
        },
        first: PAGE_SIZE,
        skip: 0,
        orderBy: 'timestamp',
        orderDirection: 'asc'
      },
      delegator: true,
      space: true,
      delegate: true,
      timestamp: true
    }
  };

  if (snapshot !== 'latest') {
    params.delegations.__args.block = { number: snapshot };
  }

  return (
    (await snapshotjs.utils.subgraphRequest(url, params)).delegations || []
  );
}

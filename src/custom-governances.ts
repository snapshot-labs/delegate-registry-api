import { Interface } from '@ethersproject/abi';
import { Contract } from '@ethersproject/contracts';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import snapshotjs from '@snapshot-labs/snapshot.js';
import { CustomGovernance, Delegation } from './types';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)'
];

const DELEGATE_REGISTRY_ABI = [
  'function delegation(address delegator, bytes32 id) view returns (address delegate)',
  'function getDelegators(address delegate, bytes32 id) view returns (address[])'
];

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const PAGE_SIZE = 1000;

function getProvider(chainId: string) {
  return new StaticJsonRpcProvider(
    `https://rpc.snapshot.org/${chainId}`,
    Number(chainId)
  );
}

export async function getOnchainScores({
  space,
  delegations
}: {
  space: CustomGovernance;
  delegations: Delegation[];
}) {
  const provider = getProvider(space.network);

  const delegateRegistryInterface = new Interface(DELEGATE_REGISTRY_ABI);
  const multicall = new Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

  const scores: Record<string, bigint> = {};

  // Delegatee's VP is equals to VP they get from delegations
  // Plus their own VP unless they delegate to someone else.
  const delegateeAddresses = Array.from(
    new Set<string>(delegations.map(delegation => delegation.delegate))
  );
  const allAddresses = Array.from(
    new Set<string>(
      delegations.flatMap(delegation => [
        delegation.delegator,
        delegation.delegate
      ])
    )
  );

  const calls = [
    ...delegateeAddresses.map(delegatee => ({
      target: space.delegationRegistry,
      allowFailure: false,
      callData: delegateRegistryInterface.encodeFunctionData('delegation', [
        delegatee,
        space.viewId
      ])
    })),
    ...allAddresses.map(address => ({
      target: MULTICALL3_ADDRESS,
      allowFailure: false,
      callData: multicall.interface.encodeFunctionData('getEthBalance', [
        address
      ])
    }))
  ];

  const results: {
    returnData: string;
  }[] = await multicall.aggregate3(calls);

  const delegateeDelegationsMap = new Map(
    results
      .slice(0, delegateeAddresses.length)
      .map((result, index) => [
        delegateeAddresses[index],
        delegateRegistryInterface.decodeFunctionResult(
          'delegation',
          result.returnData
        )[0]
      ])
  );

  const balancesMap = new Map(
    results
      .slice(delegateeAddresses.length)
      .map((result, index) => [allAddresses[index], BigInt(result.returnData)])
  );

  for (const delegation of delegations) {
    const { delegator, delegate } = delegation;

    if (!scores[delegate]) {
      scores[delegate] =
        delegateeDelegationsMap.get(delegate) ===
        '0x0000000000000000000000000000000000000000'
          ? (balancesMap.get(delegate) ?? 0n)
          : 0n;
    }

    scores[delegate] += balancesMap.get(delegator) ?? 0n;
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

import snapshotjs from '@snapshot-labs/snapshot.js';

export type Delegation = Awaited<
  ReturnType<typeof snapshotjs.utils.getDelegatesBySpace>
>[number];

export type DelegateItem = Delegation & { score: bigint };

export type CustomGovernance = {
  type: 'CUSTOM_GOVERNANCE';
  network: string;
  viewId: string;
  subgraphUrl: string;
};

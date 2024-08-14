// @ts-ignore
import { register } from '@snapshot-labs/checkpoint/dist/src/register';
import { Mutex } from 'async-mutex';
import { Governance } from '../.checkpoint/models';

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

    console.log('compute governances for', governances);

    for (const governance of governances) {
      const governanceEntity = new Governance(governance);
      governanceEntity.currentDelegates = 0;
      governanceEntity.totalDelegates = 0;
      governanceEntity.delegatedVotesRaw = '0';
      governanceEntity.delegatedVotes = '0';
      await governanceEntity.save();
    }
  } finally {
    release();
  }
}

import fs from 'fs';
import path from 'path';
import Checkpoint, { LogLevel } from '@snapshot-labs/checkpoint';
import { register } from '@snapshot-labs/checkpoint/dist/src/register';
import config from './config.json';
import { INDEXER_NAME } from './constants';
import { NoopIndexer } from './noopindexer';

const dir = __dirname.endsWith('dist/src') ? '../' : '';
const schemaFile = path.join(__dirname, `${dir}../src/schema.gql`);
const schema = fs.readFileSync(schemaFile, 'utf8');
const indexer = new NoopIndexer();

const checkpoint = new Checkpoint(schema, {
  logLevel: LogLevel.Info,
  prettifyLogs: true,
  overridesConfig: config
});
checkpoint.addIndexer(INDEXER_NAME, config, indexer);

async function setupStorageTable() {
  const { knex } = checkpoint.getBaseContext();
  console.log('checking for storage table');

  const storageTableExists = await knex.schema.hasTable('storage');
  if (!storageTableExists) {
    console.log('Creating storage table');
    await knex.schema.createTable('storage', table => {
      table.string('key').primary();
      table.string('value');
    });
  } else {
    console.log('Storage table already exists');
  }
}

// Checkpoint only indexes individual scalar columns; nothing covers the
// `upper_inf(block_range)` "current row" filter. Each hourly compute closes the
// previous row versions and inserts new ones, so the (global) delegatedVotes
// index fills with closed rows from every governance. Ordered delegate queries
// then scan past those millions of dead entries and time out. This partial
// index holds only live rows, pre-sorted for the default delegate ordering, so
// queries never touch the bloated full-column index.
async function ensureIndexes() {
  const { knex } = checkpoint.getBaseContext();

  if (!(await knex.schema.hasTable('delegates'))) return;

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS delegates_live_gov_votes
     ON delegates (governance, "delegatedVotes" DESC)
     WHERE upper_inf(block_range)`
  );
}
function createCurrentBlockTracker() {
  const knex = register.getKnex();
  let initialized = false;

  const increaseCurrentBlock = async () => {
    let current = register.getCurrentBlock(INDEXER_NAME);
    if (!initialized) {
      const storage = await knex('storage')
        .where('key', 'currentBlock')
        .first();
      current = storage ? BigInt(storage.value) : 0n;
    }

    const nextValue = current + 1n;

    initialized = true;
    register.setCurrentBlock(INDEXER_NAME, nextValue);
    await knex('storage')
      .insert({
        key: 'currentBlock',
        value: nextValue.toString()
      })
      .onConflict('key')
      .merge();

    return nextValue;
  };

  return { increaseCurrentBlock };
}

const currentBlockTracker = createCurrentBlockTracker();

export { checkpoint, setupStorageTable, ensureIndexes, currentBlockTracker };

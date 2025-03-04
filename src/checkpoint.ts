import fs from 'fs';
import path from 'path';
import Checkpoint, { LogLevel } from '@snapshot-labs/checkpoint';
import { register } from '@snapshot-labs/checkpoint/dist/src/register';
import config from './config.json';
import { NoopIndexer } from './noopindexer';

const dir = __dirname.endsWith('dist/src') ? '../' : '';
const schemaFile = path.join(__dirname, `${dir}../src/schema.gql`);
const schema = fs.readFileSync(schemaFile, 'utf8');
const indexer = new NoopIndexer();

const checkpoint = new Checkpoint(config, indexer, schema, {
  logLevel: LogLevel.Info,
  prettifyLogs: true
});

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
function createCurrentBlockTracker() {
  const knex = register.getKnex();
  let initialized = false;

  const increaseCurrentBlock = async () => {
    let current = register.getCurrentBlock();
    if (!initialized) {
      const storage = await knex('storage')
        .where('key', 'currentBlock')
        .first();
      current = storage ? BigInt(storage.value) : 0n;
    }

    const nextValue = current + 1n;

    initialized = true;
    register.setCurrentBlock(nextValue);
    await knex('storage')
      .insert({
        key: 'currentBlock',
        value: nextValue.toString()
      })
      .onConflict('key')
      .merge();
  };

  return { increaseCurrentBlock };
}

const currentBlockTracker = createCurrentBlockTracker();

export { checkpoint, setupStorageTable, currentBlockTracker };

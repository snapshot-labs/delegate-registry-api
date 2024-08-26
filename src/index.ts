import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Checkpoint, { LogLevel } from '@snapshot-labs/checkpoint';
import cors from 'cors';
import express from 'express';
import config from './config.json';
import { middleware } from './middleware';
import { NoopIndexer } from './noopindexer';

const dir = __dirname.endsWith('dist/src') ? '../' : '';
const schemaFile = path.join(__dirname, `${dir}../src/schema.gql`);
const schema = fs.readFileSync(schemaFile, 'utf8');

if (process.env.CA_CERT) {
  process.env.CA_CERT = process.env.CA_CERT.replace(/\\n/g, '\n');
}

const indexer = new NoopIndexer();
const checkpoint = new Checkpoint(config, indexer, schema, {
  logLevel: LogLevel.Info,
  prettifyLogs: true
});

async function run() {
  await checkpoint.reset();
  await checkpoint.resetMetadata();
}

run();

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ limit: '4mb', extended: false }));
app.use(cors({ maxAge: 86400 }));
app.use(middleware);
app.use('/', checkpoint.graphql);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening at http://localhost:${PORT}`));

import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { checkpoint, setupStorageTable } from './checkpoint';
import { middleware } from './middleware';

if (process.env.CA_CERT) {
  process.env.CA_CERT = process.env.CA_CERT.replace(/\\n/g, '\n');
}

setupStorageTable();

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ limit: '4mb', extended: false }));
app.use(cors({ maxAge: 86400 }));
app.use(middleware);
app.use('/', checkpoint.graphql);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening at http://localhost:${PORT}`));

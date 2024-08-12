import { BaseIndexer, BaseProvider, Instance } from '@snapshot-labs/checkpoint';
import { Logger } from '@snapshot-labs/checkpoint/dist/src/utils/logger';

export class NoopProvider extends BaseProvider {}

export class NoopIndexer extends BaseIndexer {
  init({
    instance,
    log,
    abis
  }: {
    instance: Instance;
    log: Logger;
    abis?: Record<string, any>;
  }) {
    this.provider = new NoopProvider({
      instance,
      log,
      abis
    });
  }

  public getHandlers(): string[] {
    return [];
  }
}

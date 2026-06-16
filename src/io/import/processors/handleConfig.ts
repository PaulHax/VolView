import { ImportHandler, asConfigResult } from '@/src/io/import/common';
import {
  hasDataSourceRole,
  isRemoteDataSource,
} from '@/src/io/import/dataSource';
import { ensureError } from '@/src/utils';
import { readConfigFile } from '@/src/io/import/configJson';
import { Skip } from '@/src/utils/evaluateChain';

/**
 * Reads a JSON file with label config and updates stores.
 * @param dataSource
 * @returns
 */
const handleConfig: ImportHandler = async (dataSource) => {
  if (
    dataSource.type === 'file' &&
    dataSource.fileType === 'application/json'
  ) {
    try {
      const allowProcessingConfig =
        hasDataSourceRole(dataSource, 'config') ||
        !isRemoteDataSource(dataSource);
      const manifest = await readConfigFile(dataSource.file, {
        processing: allowProcessingConfig,
      });
      // Don't consume JSON if it has no known key
      if (Object.keys(manifest).length === 0) {
        return Skip;
      }
      return asConfigResult(dataSource, manifest);
    } catch (err) {
      throw new Error('Failed to parse config file', {
        cause: ensureError(err),
      });
    }
  }
  return Skip;
};

export default handleConfig;

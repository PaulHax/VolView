import { ImportHandler, asConfigResult } from '@/src/io/import/common';
import { ensureError } from '@/src/utils';
import { recognizeConfigFile } from '@/src/io/import/configJson';
import { Skip } from '@/src/utils/evaluateChain';
import { useMessageStore } from '@/src/store/messages';

// A config-like JSON rejected only for unknown top-level keys is surfaced
// (console + user-visible notification naming the offending key) before it
// falls through to data import — config version skew must be a visible error,
// never a silent mystery import.
const surfaceConfigNearMiss = (unknownKeys: string[]) => {
  const label = unknownKeys.length === 1 ? 'key' : 'keys';
  const message =
    `Ignoring config-like JSON with unknown top-level ${label}: ` +
    `${unknownKeys.join(', ')}. Importing as data instead.`;
  console.warn(message);
  useMessageStore().addWarning('Unrecognized configuration', message);
};

/**
 * Recognizes a JSON file as VolView config BY SHAPE — no channel distinction:
 * trust for the `processing` section attaches to the provider's origin (see
 * io/originGate), not to how the config arrived. A recognized config is emitted
 * as a config result; anything else falls through (`Skip`) to normal data
 * import, and a near-miss (config-shaped but for unknown top-level keys) is
 * surfaced first.
 */
const handleConfig: ImportHandler = async (dataSource) => {
  if (
    dataSource.type !== 'file' ||
    dataSource.fileType !== 'application/json'
  ) {
    return Skip;
  }
  try {
    const recognition = await recognizeConfigFile(dataSource.file);
    if (recognition.kind === 'config') {
      return asConfigResult(dataSource, recognition.config);
    }
    if (recognition.kind === 'near-miss') {
      surfaceConfigNearMiss(recognition.unknownKeys);
    }
    return Skip;
  } catch (err) {
    throw new Error('Failed to parse config file', {
      cause: ensureError(err),
    });
  }
};

export default handleConfig;

import { Skip } from '@/src/utils/evaluateChain';
import { blobFetcher } from '@/src/core/streaming/blobFetcher';
import { CachedStreamFetcher } from '@/src/core/streaming/cachedStreamFetcher';
import { Chunk } from '@/src/core/streaming/chunk';
import { DicomDataLoader } from '@/src/core/streaming/dicom/dicomDataLoader';
import { DicomMetaLoader } from '@/src/core/streaming/dicom/dicomMetaLoader';
import { getRequestPool } from '@/src/core/streaming/requestPool';
import {
  ImportHandler,
  asIntermediateResult,
  asOkayResult,
} from '@/src/io/import/common';
import { DataSource, getDataSourceName } from '@/src/io/import/dataSource';
import { FILE_EXT_TO_MIME } from '@/src/io/mimeTypes';
import { getErrorDetail } from '@/src/utils';
import { Tags } from '@/src/core/dicomTags';
import { useMessageStore } from '@/src/store/messages';

const dicomFetcher = (dataSource: DataSource) => {
  if (
    dataSource.type === 'file' &&
    dataSource.fileType === FILE_EXT_TO_MIME.dcm
  )
    return blobFetcher(dataSource.file);

  if (dataSource.type === 'uri' && dataSource.mime === FILE_EXT_TO_MIME.dcm)
    return (
      dataSource.fetcher ??
      new CachedStreamFetcher(dataSource.uri, {
        fetch: (...args) => getRequestPool().fetch(...args),
      })
    );

  return null;
};

/**
 * Reads a DICOM source's header and hands it on as a chunk to import later.
 */
const handleDicom: ImportHandler = async (dataSource) => {
  const fetcher = dicomFetcher(dataSource);
  if (!fetcher) return Skip;

  const name = getDataSourceName(dataSource);
  const chunk = new Chunk({
    metaLoader: new DicomMetaLoader(fetcher),
    dataLoader: new DicomDataLoader(fetcher),
  });

  try {
    await chunk.loadMeta();
  } catch (error) {
    const detail = getErrorDetail(
      error,
      'the file could not be parsed as valid DICOM (check browser console for details)'
    );
    throw new Error(`Failed to read DICOM tags from ${name}: ${detail}`, {
      cause: error,
    });
  }

  const modality = new Map(chunk.metadata ?? []).get(Tags.Modality)?.trim();
  if (modality?.startsWith('RT')) {
    useMessageStore().addWarning(
      `DICOM ${modality} modality is not supported. File ${name} will be skipped.`
    );
    return asOkayResult(dataSource);
  }

  return asIntermediateResult([
    {
      type: 'chunk',
      chunk,
      mime: FILE_EXT_TO_MIME.dcm,
      parent: dataSource,
    },
  ]);
};

export default handleDicom;

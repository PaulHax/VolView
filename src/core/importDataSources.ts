import { URL } from 'whatwg-url';
import { getFileMimeType } from '../io';
import { readRemoteManifestFile } from '../io/manifest';
import { ARCHIVE_FILE_TYPES } from '../io/mimeTypes';
import { extractFilesFromZip } from '../io/zip';
import Pipeline, { Handler } from './pipeline';
import { canFetchUrl, fetchFile } from '../utils/fetch';
import { DatasetFile } from '../store/datasets-files';

/**
 * Represents a URI source with a file name for the downloaded resource.
 */
export interface UriSource {
  uri: string;
  name: string;
}

/**
 * Represents a user-specified file.
 */
export interface FileSource {
  file: File;
  fileType: string;
}

/**
 * If an archive source is specified, then it is assumed that the data source
 * has a FileSource (representing the file inside the archive), and a parent
 * data source that has a FileSource of the containing archive.
 */
export interface ArchiveSource {
  // Full path + filename inside the archive
  path: string;
}

/**
 * Represents a source of datasets.
 *
 * If the parent property is set, it represents the DataSource from which this
 * DataSource was derived.
 */
export interface DataSource {
  uriSrc?: UriSource;
  fileSrc?: FileSource;
  archiveSrc?: ArchiveSource;
  parent?: DataSource;
}

export interface ImportResult {
  dataID: string;
  dataSource: DataSource;
}

type ImportHandler = Handler<DataSource, ImportResult>;

function isArchive(r: DataSource): r is DataSource & { fileSrc: FileSource } {
  return !!r.fileSrc && ARCHIVE_FILE_TYPES.has(r.fileSrc.fileType);
}

/**
 * Transforms a file data source to have a mime type
 * @param dataSource
 */
const retypeFile: ImportHandler = async (dataSource) => {
  let src = dataSource;
  const { fileSrc } = src;
  if (fileSrc && fileSrc.fileType === '') {
    const mime = await getFileMimeType(fileSrc.file);
    if (mime) {
      src = {
        ...src,
        fileSrc: {
          ...fileSrc,
          fileType: mime,
        },
      };
    }
  }
  return src;
};

const importSingleFile: ImportHandler = async (dataSource, { done }) => {
  if (dataSource.fileSrc) {
    // pass to readers
    console.log('importing single file', dataSource);
    return done();
  }
  return dataSource;
};

/**
 * Extracts files from an archive
 * @param dataSource
 */
const extractArchive: ImportHandler = async (dataSource, { execute, done }) => {
  if (isArchive(dataSource)) {
    const files = await extractFilesFromZip(dataSource.fileSrc.file);
    files.forEach((entry) => {
      execute({
        fileSrc: {
          file: entry.file,
          fileType: '',
        },
        archiveSrc: {
          path: entry.archivePath,
        },
        parent: dataSource,
      });
    });
    return done();
  }
  return dataSource;
};

const handleRemoteManifest: ImportHandler = async (
  dataSource,
  { done, execute }
) => {
  const { fileSrc } = dataSource;
  if (fileSrc?.fileType === 'application/json') {
    const remotes: DataSource[] = [];
    try {
      const manifest = await readRemoteManifestFile(fileSrc.file);
      manifest.resources.forEach((res) => {
        remotes.push({
          uriSrc: {
            uri: res.url,
            name: res.name ?? new URL(res.url).pathname,
          },
          parent: dataSource,
        });
      });
    } catch (err) {
      return dataSource;
    }

    remotes.forEach((remote) => {
      execute(remote);
    });
    return done();
  }
  return dataSource;
};

const downloadUrl: ImportHandler = async (dataSource, { execute, done }) => {
  const { uriSrc } = dataSource;
  if (uriSrc && canFetchUrl(uriSrc.uri)) {
    const file = await fetchFile(uriSrc.uri, uriSrc.name);
    execute({
      fileSrc: {
        file,
        fileType: '',
      },
      parent: dataSource,
    });
    return done();
  }
  return dataSource;
};

const unhandledResource: ImportHandler = () => {
  throw new Error('Failed to handle a resource');
};

export async function importDataSources(dataSources: DataSource[]) {
  const dicoms: DatasetFile[] = [];
  const importDicomFile: ImportHandler = (dataSource, { done }) => {
    if (dataSource.fileSrc?.fileType === 'application/dicom') {
      dicoms.push({
        file: dataSource.fileSrc.file,
      });
      return done();
    }
    return dataSource;
  };

  const middleware: Array<ImportHandler> = [
    // retyping should be first in the pipeline
    retypeFile,
    handleRemoteManifest,
    downloadUrl,
    extractArchive,
    // should be before importSingleFile, since DICOM is more specific
    importDicomFile,
    importSingleFile,
    // catch any unhandled resource
    unhandledResource,
  ];

  const pipeline = new Pipeline(middleware);
  const results = await Promise.all(
    dataSources.map((r) => pipeline.execute(r))
  );

  console.log('dicoms:', dicoms);

  return results;
}

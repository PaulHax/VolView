import runPipelineBrowser from 'itk/runPipelineBrowser';
import { readFileAsArrayBuffer } from '@/src/io/io';
import IOTypes from 'itk/IOTypes';
import { defer } from '../utils/common';
import PriorityQueue from '../utils/priorityqueue';

export default class DicomIO {
  constructor() {
    this.webWorker = null;
    this.queue = new PriorityQueue();
    this.initializeCheck = null;
  }

  async addTask(module, args, inputs, outputs, priority = 0) {
    const deferred = defer();
    this.queue.push(
      {
        deferred,
        runArgs: [module, args, inputs, outputs],
      },
      priority
    );
    this.runTasks();
    return deferred.promise;
  }

  async runTasks() {
    if (this.tasksRunning) {
      return;
    }
    this.tasksRunning = true;

    while (this.queue.size()) {
      const { deferred, runArgs } = this.queue.pop();
      // we don't want parallelization. This is to work around
      // an issue in itk.js.
      // eslint-disable-next-line no-await-in-loop
      const result = await runPipelineBrowser(this.webWorker, ...runArgs);
      deferred.resolve(result);
    }

    this.tasksRunning = false;
  }

  /**
   * Helper that initializes the webworker.
   *
   * @async
   * @throws Error initialization failed
   */
  async initialize() {
    if (!this.initializeCheck) {
      this.initializeCheck = new Promise((resolve, reject) =>
        this.addTask('dicom', [], [], [])
          .then((result) => {
            if (result.webWorker) {
              this.webWorker = result.webWorker;
              resolve();
            } else {
              reject(new Error('Could not initialize webworker'));
            }
          })
          .catch(reject)
      );
    }
    return this.initializeCheck;
  }

  /**
   * Imports files
   * @async
   * @param {File[]} files
   * @returns SeriesUIDs
   */
  async importFiles(files) {
    await this.initialize();

    const fileData = await Promise.all(
      files.map(async (file) => {
        const buffer = await readFileAsArrayBuffer(file);
        return {
          name: file.name,
          data: buffer,
        };
      })
    );

    const result = await this.addTask(
      // module
      'dicom',
      // args
      ['import', 'output.json', ...fileData.map((fd) => fd.name)],
      // outputs
      [{ path: 'output.json', type: IOTypes.Text }],
      // inputs
      fileData.map((fd) => ({
        path: fd.name,
        type: IOTypes.Binary,
        data: new Uint8Array(fd.data),
      }))
    );

    return JSON.parse(result.outputs[0].data);
  }

  /**
   * Retrieves a slice of a series.
   * @async
   * @param {String} seriesUID the ITK-GDCM series UID
   * @param {Number} slice the slice to retrieve
   * @param {Boolean} asThumbnail cast image to unsigned char. Defaults to false.
   * @returns ItkImage
   */
  async getSeriesImage(seriesUID, slice, asThumbnail = false) {
    await this.initialize();

    const result = await this.addTask(
      'dicom',
      [
        'getSliceImage',
        'output.json',
        seriesUID,
        String(slice),
        asThumbnail ? '1' : '0',
      ],
      [{ path: 'output.json', type: IOTypes.Image }],
      [],
      -10 // computing thumbnails is a low priority task
    );

    return result.outputs[0].data;
  }

  /**
   * Builds a volume for a given series.
   * @async
   * @param {String} seriesUID the ITK-GDCM series UID
   * @returns ItkImage
   */
  async buildSeriesVolume(seriesUID) {
    await this.initialize();

    const result = await this.addTask(
      'dicom',
      ['buildSeriesVolume', 'output.json', seriesUID],
      [{ path: 'output.json', type: IOTypes.Image }],
      [],
      10 // building volumes is high priority
    );

    return result.outputs[0].data;
  }

  /**
   * Reads a TRE file.
   * @returns JSON
   */
  async readTRE(file) {
    await this.initialize();

    const fileData = {
      name: file.name,
      data: await readFileAsArrayBuffer(file),
    };

    const result = await this.addTask(
      // module
      'dicom',
      // args
      ['readTRE', 'output.json', file.name],
      // outputs
      [{ path: 'output.json', type: IOTypes.Text }],
      // inputs
      [
        {
          path: fileData.name,
          type: IOTypes.Binary,
          data: new Uint8Array(fileData.data),
        },
      ]
    );

    return JSON.parse(result.outputs[0].data);
  }
}

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function installWebGLDiagnostics(
  browser: WebdriverIO.Browser,
  directory: string,
  specs: string[]
) {
  if (process.env.VOLVIEW_WEBGL_DIAGNOSTICS !== '1') return;

  const file = join(directory, `webgl-${process.pid}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({
      event: 'browser',
      specs,
      browserName: browser.capabilities.browserName,
      browserVersion: browser.capabilities.browserVersion,
      platformName: browser.capabilities.platformName,
      chromeArgs: browser.requestedCapabilities['goog:chromeOptions']?.args,
    })}\n`
  );

  const script = await browser.addInitScript((emit) => {
    let nextContextId = 0;
    const contexts = new WeakSet<object>();
    const extensions = new WeakSet<object>();
    const record = (event: string, details: () => Record<string, unknown>) => {
      try {
        emit({
          event,
          timeOrigin: performance.timeOrigin,
          elapsed: performance.now(),
          url: location.href,
          ...details(),
        });
      } catch {
        // Diagnostics must not interrupt rendering when a document goes away.
      }
    };

    for (const event of ['beforeunload', 'pagehide']) {
      window.addEventListener(event, () => record(event, () => ({})));
    }

    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      contextId: string,
      options?: unknown
    ) {
      const result = getContext.call(this, contextId, options);
      if (!result || !/^webgl2?$/.test(contextId) || contexts.has(result)) {
        return result;
      }
      contexts.add(result);
      const gl = result as WebGLRenderingContext | WebGL2RenderingContext;
      const id = ++nextContextId;
      const contextDetails = () => ({
        contextId: id,
        width: this.width,
        height: this.height,
        lost: gl.isContextLost(),
      });
      record('context', () => {
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          ...contextDetails(),
          renderer: gl.getParameter(
            debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER
          ),
        };
      });
      for (const event of ['webglcontextlost', 'webglcontextrestored']) {
        this.addEventListener(event, (entry) =>
          record(event, () => ({
            ...contextDetails(),
            status: (entry as WebGLContextEvent).statusMessage,
          }))
        );
      }

      const getExtension = gl.getExtension.bind(gl);
      gl.getExtension = (name: string) => {
        const extension = getExtension(name);
        if (
          name === 'WEBGL_lose_context' &&
          extension &&
          !extensions.has(extension)
        ) {
          extensions.add(extension);
          const loseContext = extension.loseContext.bind(extension);
          extension.loseContext = () => {
            record('explicit-context-loss', () => ({
              ...contextDetails(),
              stack: new Error().stack,
            }));
            return loseContext();
          };
        }
        return extension;
      };

      const createShader = gl.createShader.bind(gl);
      gl.createShader = (shaderType) => {
        const shader = createShader(shaderType);
        if (!shader) {
          record('null-shader', () => ({
            ...contextDetails(),
            shaderType,
            stack: new Error().stack,
          }));
        }
        return shader;
      };
      const getShaderParameter = gl.getShaderParameter.bind(gl);
      gl.getShaderParameter = (shader, parameter) => {
        const value = getShaderParameter(shader, parameter);
        if (parameter === gl.COMPILE_STATUS && !value) {
          record('shader-compile-failed', () => ({
            ...contextDetails(),
            shaderType: shader && getShaderParameter(shader, gl.SHADER_TYPE),
            info: gl.getShaderInfoLog(shader),
            stack: new Error().stack,
          }));
        }
        return value;
      };
      return result;
    } as typeof getContext;
  });
  script.on('data', (entry) =>
    appendFileSync(file, `${JSON.stringify(entry)}\n`)
  );
}

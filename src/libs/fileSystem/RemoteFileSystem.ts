import { basename, dirname, resolve, join } from 'pathe'
import { BaseEntry, BaseFileSystem, StreamableLike } from './BaseFileSystem'
import * as JSONC from 'jsonc-parser'

type DirectoryResult = { entries: { name: string; kind: 'file' | 'directory' }[] }

export class RemoteFileSystem extends BaseFileSystem {
  private pathsToWatch: string[] = []
  private encoder = new TextEncoder()
  private decoder = new TextDecoder()

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch('/api/bridge-fs' + path, {
      credentials: 'same-origin',
      ...init,
      headers: { ...(init.body instanceof Blob ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
    })
    if (!response.ok) {
      let message = 'Bridge project storage request failed (' + response.status + ')'
      try { message = (await response.json()).error || message } catch {}
      throw new Error(message)
    }
    return response
  }

  private path(path: string): string {
    const value = resolve('/', path)
    if (value.split('/').some(part => part === '..')) throw new Error('Invalid project path')
    return value
  }

  public async readFile(path: string): Promise<ArrayBuffer> {
    return await (await this.request('/file?path=' + encodeURIComponent(this.path(path)))).arrayBuffer()
  }

  public async readFileText(path: string): Promise<string> {
    return this.decoder.decode(await this.readFile(path))
  }

  public async readFileJson(path: string): Promise<any> {
    return JSONC.parse(await this.readFileText(path))
  }

  public async readFileDataUrl(path: string): Promise<string> {
    const blob = new Blob([await this.readFile(path)])
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  }

  public async writeFile(path: string, content: FileSystemWriteChunkType): Promise<void> {
    const body = typeof content === 'string'
      ? this.encoder.encode(content)
      : content instanceof Uint8Array
        ? content
        : content instanceof ArrayBuffer
          ? new Uint8Array(content)
          : content instanceof Blob
            ? new Uint8Array(await content.arrayBuffer())
            : this.encoder.encode(String(content))
    await this.request('/file?path=' + encodeURIComponent(this.path(path)), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: body as BodyInit,
    })
    this.changed(path)
  }

  public async writeFileStreaming(path: string, stream: StreamableLike): Promise<void> {
    const chunks: Uint8Array[] = []
    await new Promise<void>((resolve, reject) => {
      stream.ondata = (error, data, final) => {
        if (error) return reject(error)
        if (data?.length) chunks.push(data)
        if (final) resolve()
      }
      stream.start()
    })
    const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    await this.writeFile(path, bytes)
  }

  public async removeFile(path: string): Promise<void> {
    await this.request('/entry?path=' + encodeURIComponent(this.path(path)), { method: 'DELETE' })
    this.changed(path)
  }

  public async readDirectoryEntries(path: string): Promise<BaseEntry[]> {
    const result = await (await this.request('/directory?path=' + encodeURIComponent(this.path(path)))).json() as DirectoryResult
    return result.entries.map(entry => new BaseEntry(join(this.path(path), entry.name), entry.kind))
  }

  public async ensureDirectory(path: string): Promise<void> {
    const target = this.path(path)
    const parent = dirname(target)
    if (parent !== '/' && !(await this.exists(parent))) await this.ensureDirectory(parent)
    if (!(await this.exists(target))) await this.makeDirectory(target)
  }

  public async makeDirectory(path: string): Promise<void> {
    await this.request('/directory', { method: 'POST', body: JSON.stringify({ path: this.path(path) }) })
    this.changed(path)
  }

  public async removeDirectory(path: string): Promise<void> {
    await this.request('/entry?path=' + encodeURIComponent(this.path(path)), { method: 'DELETE' })
    this.changed(path)
  }

  public async exists(path: string): Promise<boolean> {
    const response = await this.request('/exists?path=' + encodeURIComponent(this.path(path)))
    return (await response.json()).exists === true
  }

  public async watch(path: string): Promise<void> {
    const value = this.path(path)
    if (!this.pathsToWatch.includes(value)) this.pathsToWatch.push(value)
  }

  public async unwatch(path: string): Promise<void> {
    const value = this.path(path)
    this.pathsToWatch = this.pathsToWatch.filter(item => item !== value)
  }

  private changed(path: string): void {
    const value = this.path(path)
    if (this.pathsToWatch.some(watched => value === watched || value.startsWith(watched + '/'))) {
      if (!this.modificationsAnnounced()) this.pathUpdated.dispatch(value)
    }
  }
}

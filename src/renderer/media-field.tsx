import { useState } from 'react'
import type { MediaBlob } from '@core/api'
import { toMediaUrl } from '@core/media'
import type { StoredFile } from '@core/types'
import { clipboardHasFiles } from './ui'

export type MediaAccept = 'image' | 'file' | 'any'

export function MediaPicker({
  accept,
  files,
  disabled = false,
  onChange
}: {
  accept: MediaAccept
  files: StoredFile[]
  disabled?: boolean
  onChange: (files: StoredFile[]) => void
}) {
  const [note, setNote] = useState<string | null>(null)

  function append(picked: StoredFile[]) {
    if (!picked.length) return
    setNote(null)
    onChange([...files, ...picked])
  }

  function emptyNote() {
    setNote(accept === 'image' ? 'В буфере нет изображения' : 'В буфере нет файла')
  }

  return (
    <div
      className="media-picker"
      tabIndex={0}
      onPaste={(event) => {
        if (disabled || !clipboardHasFiles(event.clipboardData)) return
        event.preventDefault()
        event.stopPropagation()
        void attachmentsFromTransfer(event.clipboardData, accept)
          .then((picked) => {
            if (!picked.length) emptyNote()
            else append(picked)
          })
          .catch((reason) => setNote(reason instanceof Error ? reason.message : 'Не удалось вставить файл'))
      }}
    >
      {files.length > 0 && (
        <div className="row">
          {files.map((file) => (
            <div key={file.path} className="media-item">
              {file.kind === 'image' ? (
                <img className="preview" alt={file.name} src={toMediaUrl(file.path)} />
              ) : (
                <span className="meta">{file.name}</span>
              )}
              <button
                className="ghost"
                type="button"
                disabled={disabled}
                onClick={() => onChange(files.filter((item) => item.path !== file.path))}
              >
                Удалить
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <button
          className="ghost"
          type="button"
          disabled={disabled}
          onClick={() => {
            void window.pipeline
              .pickFiles(accept === 'any' ? 'auto' : accept, true)
              .then((picked) => append(picked))
              .catch((reason) => setNote(reason instanceof Error ? reason.message : 'Не удалось выбрать файл'))
          }}
        >
          Выбрать
        </button>
        <button
          className="ghost"
          type="button"
          disabled={disabled}
          onClick={() => {
            void pasteClipboard(accept)
              .then((picked) => {
                if (!picked.length) emptyNote()
                else append(picked)
              })
              .catch((reason) => setNote(reason instanceof Error ? reason.message : 'Не удалось вставить файл'))
          }}
        >
          Вставить
        </button>
        {files.length > 0 && (
          <button className="ghost" type="button" disabled={disabled} onClick={() => onChange([])}>
            Очистить
          </button>
        )}
      </div>
      <p className="field-note">
        {accept === 'image'
          ? 'Новые изображения добавляются к уже выбранным. Сюда же можно вставить из буфера.'
          : accept === 'file'
            ? 'Новые файлы добавляются к уже выбранным. Сюда же можно вставить из буфера.'
            : 'Новые фото и файлы добавляются к уже выбранным. Сюда же можно вставить из буфера.'}
      </p>
      {note && <span className="meta">{note}</span>}
    </div>
  )
}

async function pasteClipboard(accept: MediaAccept): Promise<StoredFile[]> {
  const stored = await window.pipeline.pasteMedia(accept)
  if (stored.length) return stored
  return imagesFromPageClipboard(accept)
}

async function imagesFromPageClipboard(accept: MediaAccept): Promise<StoredFile[]> {
  if (!navigator.clipboard?.read) return []
  let items: ClipboardItem[]
  try {
    items = await navigator.clipboard.read()
  } catch {
    return []
  }
  const blobs: MediaBlob[] = []
  for (const item of items) {
    const type = item.types.find((entry) => entry === 'image/png') ?? item.types.find((entry) => entry.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    const mime = type === 'image/jpg' ? 'image/jpeg' : type
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'png'
    blobs.push({
      name: `clipboard.${ext}`,
      mime,
      bytes: new Uint8Array(await blob.arrayBuffer()),
      kind: accept === 'file' ? 'file' : 'image'
    })
  }
  if (!blobs.length) return []
  return window.pipeline.storeMedia(blobs)
}

export async function attachmentsFromTransfer(data: DataTransfer | null, accept: MediaAccept): Promise<StoredFile[]> {
  const blobs = await blobsFromTransfer(data, accept)
  if (!blobs.length) return []
  return window.pipeline.storeMedia(blobs)
}

function kindFor(file: File, accept: MediaAccept): 'image' | 'file' | null {
  const image = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name)
  if (accept === 'image') return image ? 'image' : null
  if (accept === 'file') return 'file'
  return image ? 'image' : 'file'
}

async function blobsFromTransfer(data: DataTransfer | null, accept: MediaAccept): Promise<MediaBlob[]> {
  const blobs: MediaBlob[] = []
  for (const file of transferFiles(data)) {
    const kind = kindFor(file, accept)
    if (!kind) continue
    blobs.push({
      name: file.name || (kind === 'image' ? 'clipboard.png' : 'clipboard.bin'),
      mime: file.type || (kind === 'image' ? 'image/png' : 'application/octet-stream'),
      bytes: new Uint8Array(await file.arrayBuffer()),
      kind
    })
  }
  return blobs
}

function transferFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  if (data.files.length) return [...data.files]
  const files: File[] = []
  for (const item of data.items) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

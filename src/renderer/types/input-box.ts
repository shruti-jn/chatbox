export interface PreprocessedFile {
  file: File
  content: string
  storageKey: string
  tokenCountMap?: Record<string, number>
  lineCount?: number
  byteLength?: number
  error?: string
}

export interface PreprocessedLink {
  url: string
  title: string
  content: string
  storageKey: string
  tokenCountMap?: Record<string, number>
  lineCount?: number
  byteLength?: number
  error?: string
}

export interface PreConstructedMessageState {
  text: string
  pictureKeys: string[]
  attachments: File[]
  links: { url: string }[]
  preprocessedFiles: PreprocessedFile[]
  preprocessedLinks: PreprocessedLink[]
  preprocessingStatus: {
    files: Record<string, 'processing' | 'completed' | 'error' | undefined>
    links: Record<string, 'processing' | 'completed' | 'error' | undefined>
  }
  preprocessingPromises: {
    files: Map<string, Promise<unknown>>
    links: Map<string, Promise<unknown>>
  }
  message?: import('@shared/types').Message
}

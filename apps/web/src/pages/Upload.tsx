import { useState, type DragEvent } from 'react';
import type { Api } from '../api';
import { href } from '../route';
import { browserJpeg, picked, plan, prepare } from '../upload';

interface Line {
  readonly name: string;
  readonly state: 'sending' | 'stored' | 'known' | 'failed';
  readonly detail?: string;
  readonly sha256?: string;
}

/**
 * Adds documents from this computer or phone browser: PDFs as they are, photos as
 * the pages of one document. Each goes in under its hash, so sending the same file
 * twice keeps one copy and says so.
 */
export function Upload({ api, onDone }: { api: Api; onDone: () => void }) {
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [over, setOver] = useState(false);

  async function send(files: readonly File[]) {
    const { parts, skipped } = plan(files.map(picked));
    const out: Line[] = skipped.map((name) => ({
      name,
      state: 'failed' as const,
      detail: 'only PDFs, EPUB books and photos can be added',
    }));
    const show = () => setLines([...out]);
    for (const part of parts) {
      const index = out.push({ name: part.name, state: 'sending' }) - 1;
      show();
      try {
        if (part.kind === 'book') {
          const sent = await api.uploadBook(await part.file.bytes());
          out[index] = sent.ok
            ? { name: part.name, state: sent.value.state, sha256: sent.value.sha256 }
            : { name: part.name, state: 'failed', detail: sent.message };
          show();
          continue;
        }
        const ready = await prepare(part, (file) => browserJpeg(file as ReturnType<typeof picked>));
        if ('problem' in ready) {
          out[index] = { name: part.name, state: 'failed', detail: ready.problem };
        } else {
          const sent = await api.upload(ready.sha256, ready.bytes, ready.pageCount);
          out[index] = sent.ok
            ? { name: part.name, state: sent.value, sha256: ready.sha256 }
            : { name: part.name, state: 'failed', detail: sent.message };
        }
      } catch (error) {
        out[index] = {
          name: part.name,
          state: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      show();
    }
    onDone();
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    void send([...event.dataTransfer.files]);
  };

  return (
    <section
      className={`card upload${over ? ' over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <h2>Add documents</h2>
      <p className="muted">
        Drop PDFs or photos here. Photos chosen together become the pages of one document.
      </p>
      <div className="actions">
        <label className="button">
          Choose files
          <input
            type="file"
            multiple
            accept="application/pdf,application/epub+zip,.epub,image/*"
            hidden
            onChange={(event) => {
              void send([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </label>
        <label className="button secondary">
          Take a photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(event) => {
              void send([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </label>
      </div>
      {lines.length === 0 ? null : (
        <ul className="upload-lines">
          {lines.map((line, i) => (
            <li key={i} className={line.state === 'failed' ? 'error' : undefined}>
              {line.sha256 === undefined ? (
                line.name
              ) : (
                <a href={href({ page: 'document', sha256: line.sha256 })}>{line.name}</a>
              )}
              :{' '}
              {line.state === 'sending'
                ? 'sending…'
                : line.state === 'stored'
                  ? 'added'
                  : line.state === 'known'
                    ? 'already here'
                    : (line.detail ?? 'failed')}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

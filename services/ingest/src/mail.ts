import type { Duplex } from 'node:stream';
import { MAX_DOCUMENT_BYTES } from '@sheaf/protocol';
import { isEpub, storeBook } from './epub.ts';
import { ImapSession } from './imap.ts';
import { parseMail } from './mime.ts';
import { sha256Hex, type Storage } from './storage.ts';

export interface MailOptions {
  readonly user: string;
  readonly password: string;
  readonly folder: string;
  /** What to do with a message once its PDFs are stored. */
  readonly after: 'seen' | 'delete';
  /** Put on every document that came by mail. */
  readonly tag: string | null;
  /** Opens the connection: TLS to the server in use, a plain socket in tests. */
  connect(): Promise<Duplex>;
  now(): number;
}

export interface MailResult {
  readonly messages: number;
  readonly stored: number;
  readonly duplicates: number;
  readonly failed: number;
}

/** At most this many messages a pass, so one huge mailbox does not hold everything up. */
const BATCH = 25;

/**
 * Takes in the PDFs attached to unread mail in one folder.
 *
 * A message is marked read (or deleted) only once every PDF in it is stored, so a
 * failure leaves it unread to be tried again on the next pass. A message with no
 * PDF is marked read too: there is nothing to take, and asking again would not
 * change that. A new document with one PDF and a subject takes the subject as its
 * title, on the server's account, so a person's or a rule's choice still wins.
 */
export class MailFetcher {
  readonly #storage: Storage;
  readonly #options: MailOptions;

  constructor(storage: Storage, options: MailOptions) {
    this.#storage = storage;
    this.#options = options;
  }

  async tick(): Promise<MailResult> {
    const options = this.#options;
    const session = new ImapSession(await options.connect());
    let messages = 0;
    let stored = 0;
    let duplicates = 0;
    let failed = 0;
    let deleted = false;
    try {
      await session.greeting();
      await session.login(options.user, options.password);
      await session.select(options.folder);
      for (const uid of (await session.unseen()).slice(0, BATCH)) {
        messages++;
        try {
          const mail = parseMail(await session.fetch(uid));
          for (const attachment of mail.attachments) {
            if (attachment.bytes.length > MAX_DOCUMENT_BYTES) {
              failed++;
              continue;
            }
            let sha256: string;
            let outcome: 'stored' | 'already-stored';
            if (isEpub(attachment.bytes)) {
              ({ sha256, outcome } = await storeBook(
                this.#storage,
                attachment.bytes,
                options.now(),
              ));
            } else {
              sha256 = sha256Hex(attachment.bytes);
              outcome = await this.#storage.put(sha256, attachment.bytes, options.now(), null);
            }
            if (outcome === 'stored') stored++;
            else duplicates++;
            if (options.tag !== null) await this.#storage.addTags(sha256, [options.tag]);
            const record = await this.#storage.record(sha256);
            if (
              outcome === 'stored' &&
              mail.attachments.length === 1 &&
              mail.subject !== null &&
              mail.subject.trim() !== '' &&
              record?.title === null
            ) {
              await this.#storage.fileByMachine(sha256, {
                title: mail.subject.trim().slice(0, 300),
              });
            }
          }
          await session.flag(uid, options.after === 'delete' ? '\\Deleted' : '\\Seen');
          if (options.after === 'delete') deleted = true;
        } catch {
          failed++;
        }
      }
      if (deleted) await session.expunge();
    } finally {
      await session.logout();
    }
    return { messages, stored, duplicates, failed };
  }
}

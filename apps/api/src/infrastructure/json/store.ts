import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  JsonStorageError,
  type JsonCollection,
  type JsonCollections,
} from "./models.js";
import {
  checkedCollection,
  collectionFiles,
  parseCollection,
} from "./schema.js";

/** Local/demo storage. Use one instance per trusted directory and process. */
export class JsonFileStore {
  private readonly directory: string;
  private readonly operations = new Map<JsonCollection, Promise<void>>();

  constructor(directory: string) {
    if (typeof directory !== "string" || !directory.trim())
      throw new TypeError("A trusted JSON storage directory is required.");
    this.directory = resolve(directory);
  }

  async read<K extends JsonCollection>(
    collection: K,
  ): Promise<JsonCollections[K][]> {
    checkedCollection(collection);
    return this.ordered(collection, async () => {
      const path = join(this.directory, collectionFiles[collection]);
      let bytes: Buffer;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        bytes = await readFile(path);
      } catch {
        throw new JsonStorageError("read_failed");
      }
      try {
        return parseCollection(
          collection,
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } catch {
        throw new JsonStorageError("invalid_data");
      }
    });
  }

  /** Infrastructure import/fixture primitive, not a business CRUD operation.
   * Explicitly replaces a whole collection; no hidden merge or read/modify/write.
   */
  async replace<K extends JsonCollection>(
    collection: K,
    records: readonly JsonCollections[K][],
  ): Promise<void> {
    checkedCollection(collection);
    // Snapshot/validate before awaiting queued I/O, so caller mutation cannot race.
    const text =
      JSON.stringify(parseCollection(collection, records), null, 2) + "\n";
    await this.ordered(collection, () => this.publish(collection, text));
  }

  private async ordered<T>(
    collection: JsonCollection,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Windows may deny rename while a reader holds the destination open. Order
    // reads with writes, not just writes with one another, on this store instance.
    const previous = this.operations.get(collection) ?? Promise.resolve();
    const result = previous.then(operation);
    const completed = result.then(
      () => {},
      () => {},
    );
    this.operations.set(collection, completed);
    try {
      return await result;
    } finally {
      if (this.operations.get(collection) === completed)
        this.operations.delete(collection);
    }
  }

  private async publish(
    collection: JsonCollection,
    text: string,
  ): Promise<void> {
    const temporary = join(
      this.directory,
      `.${collection}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(this.directory, { recursive: true });
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(
        temporary,
        join(this.directory, collectionFiles[collection]),
      );
    } catch {
      // Best-effort cleanup; a failed publication never truncates the old file.
      await unlink(temporary).catch(() => {});
      throw new JsonStorageError("write_failed");
    }
  }
}

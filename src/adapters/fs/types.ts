import * as fs from "fs"
import * as fsPromises from "fs/promises"

export type IFileSystemComponent = Pick<typeof fs, "createReadStream"> &
  Pick<typeof fs, "createWriteStream"> &
  Pick<typeof fsPromises, "access" | "opendir" | "stat" | "unlink" | "mkdir" | "readdir" | "readFile"> & {
    constants: Pick<typeof fs.constants, "F_OK" | "R_OK">
  } & {
    existPath(path: string): Promise<boolean>
  }

import { createHash, randomBytes, randomInt } from "node:crypto";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@webdrop/shared/protocol";

/** 128-bit random id (22 base64url chars). */
export const newPeerId = (): string => randomBytes(16).toString("base64url");

/** 256-bit random resume token (43 base64url chars). Only its hash is stored. */
export const newResumeToken = (): string => randomBytes(32).toString("base64url");

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("base64url");

/** Unbiased random room code using crypto.randomInt. */
export function newRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return code;
}

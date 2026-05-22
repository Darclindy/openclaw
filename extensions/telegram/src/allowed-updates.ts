import { API_CONSTANTS } from "grammy";

export type TelegramUpdateType = (typeof API_CONSTANTS.ALL_UPDATE_TYPES)[number];
export type TelegramAllowedUpdateType = Exclude<TelegramUpdateType, "guest_message">;

export const DEFAULT_TELEGRAM_UPDATE_TYPES: ReadonlyArray<TelegramAllowedUpdateType> = (
  API_CONSTANTS.DEFAULT_UPDATE_TYPES as ReadonlyArray<TelegramUpdateType>
).filter((update): update is TelegramAllowedUpdateType => update !== "guest_message");

export function resolveTelegramAllowedUpdates(): ReadonlyArray<TelegramAllowedUpdateType> {
  const updates = [...DEFAULT_TELEGRAM_UPDATE_TYPES];
  if (!updates.includes("message_reaction")) {
    updates.push("message_reaction");
  }
  if (!updates.includes("channel_post")) {
    updates.push("channel_post");
  }
  return updates;
}

import { getRequestConfig } from "next-intl/server";
import { messages } from "./messages";

export default getRequestConfig(async () => ({
  locale: "th",
  messages,
  timeZone: "Asia/Bangkok",
}));

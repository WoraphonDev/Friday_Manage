// W21 · ภาษา TH / EN · ฝั่ง server ใช้ `./server` (getRequestLocale, loadMessages) แยกต่างหาก
export { LocaleSwitch, LocaleSync, type LocaleSwitchProps } from "./LocaleSwitch";
export { readLocaleCookie, writeLocaleCookie } from "./cookie";
export {
  DEFAULT_LOCALE,
  LANGUAGE_NAMES,
  LOCALES,
  LOCALE_COOKIE,
  dateLocale,
  defaultYearFormat,
  effectiveYearFormat,
  isLocale,
  type AppLocale,
} from "./locale";
export { mergeMessages } from "./merge-messages";
export { parseAcceptLanguage, resolveLocale } from "./resolve-locale";

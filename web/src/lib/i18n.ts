import type { LocalizedText } from "../../../spec/listing.ts";
import type { Locale, ListSort } from "../../../spec/api.ts";
import type { ListingKind } from "../../../spec/listing.ts";

export function pick(text: LocalizedText, locale: Locale): string {
  return (locale === "ja" ? text.ja : text.en) || text.en || text.ja;
}

type Dict = Record<Locale, string>;
const S = {
  appName: { ja: "Takosumi Store", en: "Takosumi Store" },
  storeSubtitle: {
    ja: "install できる Capsule を探す、分散型のアプリストア。",
    en: "Browse installable Capsules across decentralized stores.",
  },
  skipToContent: { ja: "本文へスキップ", en: "Skip to content" },
  primaryNav: { ja: "主なメニュー", en: "Primary navigation" },
  tagFilters: { ja: "タグで絞り込み", en: "Filter by tag" },
  searchPlaceholder: {
    ja: "アプリ名・説明・タグで検索…",
    en: "Search apps, descriptions, or tags…",
  },
  searchLabel: { ja: "アプリを検索", en: "Search apps" },
  clearSearch: { ja: "検索をクリア", en: "Clear search" },
  resetFilters: { ja: "絞り込みを解除", en: "Clear filters" },
  sortLabel: { ja: "並び順", en: "Sort order" },
  sortUpdated: { ja: "更新順", en: "Recently updated" },
  sortName: { ja: "名前順", en: "Name" },
  resultsCount: { ja: "件表示", en: "shown" },
  all: { ja: "すべて", en: "All" },
  apps: { ja: "アプリ", en: "Apps" },
  allApps: { ja: "すべてのアプリ", en: "All apps" },
  recentlyAdded: { ja: "新着・更新", en: "Recently updated" },
  loadMore: { ja: "もっと見る", en: "Load more" },
  loadMoreMatches: {
    ja: "さらに読み込んで検索",
    en: "Load more to search",
  },
  partialResultsHint: {
    ja: "読み込み済みのアプリから表示しています。",
    en: "Showing matches from loaded apps so far.",
  },
  loadMoreFailed: {
    ja: "続きを読み込めませんでした。",
    en: "Couldn’t load more apps.",
  },
  loading: { ja: "読み込み中…", en: "Loading…" },
  noResults: {
    ja: "該当する Capsule がありません",
    en: "No matching Capsules",
  },
  noResultsHint: {
    ja: "検索語やタグを変えて探してみてください。",
    en: "Try a different search term or tag.",
  },
  errorTitle: { ja: "読み込めませんでした", en: "Couldn’t load" },
  errorHint: {
    ja: "接続を確認して、もう一度お試しください。",
    en: "Check your connection and try again.",
  },
  retry: { ja: "再試行", en: "Retry" },
  back: { ja: "戻る", en: "Back" },
  // detail
  about: { ja: "概要", en: "About" },
  developer: { ja: "提供", en: "Developer" },
  source: { ja: "ソース", en: "Source" },
  modulePath: { ja: "モジュール", en: "Module" },
  updatedAt: { ja: "更新日", en: "Updated" },
  openRepo: { ja: "リポジトリを開く", en: "Open repository" },
  alsoOnStores: {
    ja: "他のストアにもあります",
    en: "Also on other stores",
  },
  // install
  install: { ja: "追加", en: "Add" },
  openInTakos: { ja: "追加画面で開く", en: "Open add flow" },
  installHint: {
    ja: "Git URL を追加画面へ渡します。設定と実行は Takosumi 側で確認します。",
    en: "Passes the Git URL to the add flow. Takosumi handles configuration and execution confirmation.",
  },
  installTarget: { ja: "インストール先", en: "Target" },
  whereInstall: {
    ja: "あなたの Takos の URL",
    en: "Your Takos URL",
  },
  takosOriginPlaceholder: {
    ja: "https://takos.example.com",
    en: "https://takos.example.com",
  },
  invalidOriginError: {
    ja: "https:// または http:// から始まる有効な URL を入力してください。",
    en: "Enter a valid URL starting with https:// or http://.",
  },
  change: { ja: "変更", en: "Change" },
  cancel: { ja: "キャンセル", en: "Cancel" },
  save: { ja: "保存", en: "Save" },
  copyLink: { ja: "リンクをコピー", en: "Copy link" },
  copyCode: { ja: "コピー", en: "Copy" },
  copyCodeLabel: { ja: "コードをコピー", en: "Copy code" },
  copied: { ja: "コピーしました", en: "Copied" },
  copyFailed: {
    ja: "クリップボードにコピーできませんでした",
    en: "Could not copy to clipboard",
  },
  scrollPrev: { ja: "前へスクロール", en: "Scroll previous" },
  scrollNext: { ja: "次へスクロール", en: "Scroll next" },
  // account / publish
  servers: { ja: "ストアサーバー", en: "Store servers" },
  signIn: { ja: "ログイン", en: "Sign in" },
  signOut: { ja: "ログアウト", en: "Sign out" },
  publish: { ja: "公開", en: "Publish" },
  publishApp: { ja: "リポジトリを共有", en: "Share repository" },
  publishAction: { ja: "共有する", en: "Share" },
  gitUrl: { ja: "Git URL", en: "Git URL" },
  displayName: { ja: "名前", en: "Name" },
  displayNamePlaceholder: { ja: "（repo 名から自動）", en: "(auto from repo)" },
  logoUrl: { ja: "ロゴ画像 URL", en: "Logo image URL" },
  advanced: { ja: "詳細設定", en: "Advanced" },
  kindField: { ja: "種別", en: "Kind" },
  tagsField: { ja: "タグ", en: "Tags" },
  tagsHint: {
    ja: "Enter かカンマで追加。自由に付けられます。",
    en: "Press Enter or comma to add. Free-form.",
  },
  tagsLimitReached: {
    ja: "タグは最大 8 件まで追加できます。",
    en: "Up to 8 tags maximum.",
  },
  tagsPlaceholder: {
    ja: "例: social, activitypub",
    en: "e.g. social, activitypub",
  },
  removeTag: { ja: "タグを削除", en: "Remove tag" },
  descriptionField: { ja: "説明", en: "Description" },
  scopeSubtitle: {
    ja: "この発行者が共有したリポジトリ",
    en: "Repositories shared by this publisher",
  },
  scopeCountSingle: { ja: "1 件のリポジトリ", en: "1 repository" },
  scopeCountPlural: { ja: "件のリポジトリ", en: "repositories" },
  scopeEmpty: {
    ja: "このスコープにリポジトリはありません",
    en: "No repositories in this scope",
  },
  livePreview: { ja: "カード表示プレビュー", en: "Listing card preview" },
  previewFallbackName: { ja: "アプリ名", en: "App name" },
  previewFallbackDesc: {
    ja: "説明文を入力するとここに表示されます。",
    en: "Your description will appear here.",
  },
  gitUrlRequired: {
    ja: "Git リポジトリの URL を入力してください。",
    en: "Enter a Git repository URL.",
  },
  gitUrlInvalid: {
    ja: "https:// または http:// から始まる有効な Git URL を入力してください。",
    en: "Enter a valid Git URL starting with https:// or http://.",
  },
  logoUrlInvalid: {
    ja: "ロゴ画像は https:// から始まる有効な URL を入力してください。",
    en: "Enter a valid HTTPS image URL starting with https://.",
  },
  slugInvalid: {
    ja: "スラッグは半角小文字英数字とハイフン（1〜48文字）で入力してください。",
    en: "Use lowercase letters, numbers, and hyphens (1–48 characters).",
  },
  handleRequired: {
    ja: "ハンドルを入力してください。",
    en: "Enter a handle.",
  },
  handleInvalid: {
    ja: "ハンドルは半角小文字英数字とハイフン（1〜32文字）で入力してください。",
    en: "Use lowercase letters, numbers, and hyphens (1–32 characters).",
  },
  slug: { ja: "スラッグ（URL 名・任意）", en: "Slug (URL name, optional)" },
  slugPlaceholder: { ja: "名前から自動生成", en: "auto from the name" },
  publicId: { ja: "公開 ID", en: "Public id" },
  publicIdHint: {
    ja: "スコープはあなたのハンドルです。URL は scope/slug になります。",
    en: "The scope is your handle. The URL will be scope/slug.",
  },
  quota: { ja: "公開枠", en: "Listing quota" },
  quotaReached: {
    ja: "公開枠の上限に達しました",
    en: "You've reached your listing quota",
  },
  setHandle: { ja: "ハンドルを設定", en: "Set a handle" },
  handlePlaceholder: { ja: "ハンドル名", en: "handle" },
  close: { ja: "閉じる", en: "Close" },
  // manage / publisher dashboard
  manage: { ja: "管理", en: "Manage" },
  myListings: { ja: "共有中のリポジトリ", en: "Your shared repositories" },
  manageSubtitle: {
    ja: "共有したリポジトリの表示情報・公開状態・削除を管理できます。",
    en: "Edit display information, visibility, or delete repositories you've shared.",
  },
  noListings: {
    ja: "まだリポジトリを共有していません。",
    en: "You haven't shared any repositories yet.",
  },
  publishFirst: {
    ja: "最初のリポジトリを共有",
    en: "Share your first repository",
  },
  edit: { ja: "編集", en: "Edit" },
  editApp: { ja: "リポジトリ表示を編集", en: "Edit repository listing" },
  updateAction: { ja: "更新する", en: "Save changes" },
  refreshVersion: { ja: "最新コミットに更新", en: "Update to latest commit" },
  refreshing: { ja: "更新中…", en: "Updating…" },
  unpublishing: { ja: "非公開にしています…", en: "Unpublishing…" },
  republishing: { ja: "公開しています…", en: "Republishing…" },
  deleting: { ja: "削除中…", en: "Deleting…" },
  refreshed: { ja: "更新しました", en: "Updated" },
  unpublished: { ja: "非公開にしました", en: "Unlisted" },
  republished: { ja: "公開しました", en: "Published" },
  deleted: { ja: "削除しました", en: "Deleted" },
  unpublish: { ja: "非公開にする", en: "Unpublish" },
  republish: { ja: "公開する", en: "Republish" },
  deleteAction: { ja: "削除", en: "Delete" },
  confirmDeleteTitle: {
    ja: "リポジトリ表示を削除しますか？",
    en: "Delete repository listing?",
  },
  confirmDelete: {
    ja: "このリポジトリ表示を完全に削除します。よろしいですか？",
    en: "Permanently delete this repository listing. Are you sure?",
  },
  statusVisible: { ja: "公開中", en: "Public" },
  statusHidden: { ja: "非公開", en: "Unlisted" },
  version: { ja: "バージョン", en: "Version" },
  readme: { ja: "README", en: "README" },
  readmeFrom: { ja: "リポジトリの README", en: "From the repository README" },
  actionFailed: { ja: "操作に失敗しました", en: "That action failed" },
  // theme toggle (label describes the target theme)
  switchToLight: {
    ja: "ライトモードに切り替え",
    en: "Switch to light mode",
  },
  switchToDark: {
    ja: "ダークモードに切り替え",
    en: "Switch to dark mode",
  },
  // language switcher (label is shown in the *target* language)
  switchLanguage: { ja: "English", en: "日本語" },
  switchLanguageLabel: {
    ja: "Switch language to English",
    en: "表示言語を日本語に切り替え",
  },
  // not found / empty catalog / signed-out notices
  notFoundTitle: {
    ja: "ページが見つかりません",
    en: "Page not found",
  },
  notFoundHint: {
    ja: "URL が間違っているか、ページが移動・削除された可能性があります。",
    en: "The URL may be wrong, or the page was moved or removed.",
  },
  listingNotFoundTitle: {
    ja: "Capsule が見つかりません",
    en: "Capsule not found",
  },
  listingNotFoundHint: {
    ja: "非公開・削除されたか、URL が間違っている可能性があります。",
    en: "It may have been unlisted or removed, or the URL is wrong.",
  },
  editNotFoundTitle: {
    ja: "編集対象のリポジトリが見つかりません",
    en: "Repository listing not found",
  },
  editNotFoundHint: {
    ja: "削除されたか、このアカウントで管理できないリポジトリです。",
    en: "It may have been deleted or doesn’t belong to this account.",
  },
  backToManage: { ja: "管理一覧へ戻る", en: "Back to Manage" },
  browseCatalog: { ja: "アプリ一覧へ", en: "Browse apps" },
  emptyCatalogTitle: {
    ja: "まだ Capsule が公開されていません",
    en: "No Capsules published yet",
  },
  emptyCatalogHint: {
    ja: "リポジトリが共有されると、ここに表示されます。",
    en: "Shared repositories will appear here.",
  },
  signInToPublish: {
    ja: "リポジトリを共有するには、Takosumi Accounts でログインしてください。",
    en: "Sign in with Takosumi Accounts to share a repository.",
  },
  signInToManage: {
    ja: "共有したリポジトリを管理するには、Takosumi Accounts でログインしてください。",
    en: "Sign in with Takosumi Accounts to manage your shared repositories.",
  },
  readOnlyPublish: {
    ja: "このストアは現在 読み取り専用です（公開は無効）。",
    en: "This store is currently read-only (publishing disabled).",
  },
  readOnly: {
    ja: "このストアは現在 読み取り専用です。",
    en: "This store is currently read-only.",
  },
} satisfies Record<string, Dict>;

export type StringKey = keyof typeof S;
export function t(key: StringKey, locale: Locale): string {
  return S[key][locale];
}

export const SORTS: readonly ListSort[] = ["updated", "name"];

/** Human label for a Capsule kind. */
export function kindLabel(kind: ListingKind, locale: Locale): string {
  const map: Record<ListingKind, Dict> = {
    worker: { ja: "Webアプリ", en: "Web app" },
    site: { ja: "Webサイト", en: "Website" },
    storage: { ja: "ストレージ", en: "Storage" },
  };
  return map[kind][locale];
}

/** Human label for a (free-string) store category facet. */
const CATEGORY_LABELS: Record<string, Dict> = {
  workspace: { ja: "ワークスペース", en: "Workspace" },
  social: { ja: "ソーシャル", en: "Social" },
  productivity: { ja: "仕事効率化", en: "Productivity" },
  tools: { ja: "ツール", en: "Tools" },
  storage: { ja: "ストレージ", en: "Storage" },
  starter: { ja: "スターター", en: "Starter" },
  personal: { ja: "パーソナル", en: "Personal" },
  developer: { ja: "開発者向け", en: "Developer" },
  media: { ja: "メディア", en: "Media" },
};
export function categoryLabel(category: string, locale: Locale): string {
  const found = CATEGORY_LABELS[category.toLowerCase()];
  if (found) return found[locale];
  return category.charAt(0).toUpperCase() + category.slice(1);
}

const TAG_PROPER_NAMES: Readonly<Record<string, string>> = {
  ai: "AI",
  activitypub: "ActivityPub",
  api: "API",
  cli: "CLI",
  dns: "DNS",
  git: "Git",
  http: "HTTP",
  oidc: "OIDC",
  oss: "OSS",
  sns: "SNS",
  ui: "UI",
};

/**
 * Human label for a free-form tag. Reuses the known-category labels, otherwise
 * turns "dev-tools" into "Dev Tools" while preserving common acronyms.
 */
export function tagLabel(tag: string, locale: Locale): string {
  const lower = tag.toLowerCase();
  const found = CATEGORY_LABELS[lower];
  if (found) return found[locale];
  if (TAG_PROPER_NAMES[lower]) return TAG_PROPER_NAMES[lower]!;
  return tag
    .split("-")
    .filter(Boolean)
    .map(
      (w) =>
        TAG_PROPER_NAMES[w.toLowerCase()] ??
        w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

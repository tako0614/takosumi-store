import type { LocalizedText } from "../../../spec/listing.ts";
import type { Locale, ListSort } from "../../../spec/api.ts";
import type { ListingKind } from "../../../spec/listing.ts";

export function pick(text: LocalizedText, locale: Locale): string {
  return (locale === "ja" ? text.ja : text.en) || text.en || text.ja;
}

type Dict = Record<Locale, string>;
const S = {
  appName: { ja: "Takosumi Store", en: "Takosumi Store" },
  tagline: {
    ja: "Git で公開された OpenTofu Capsule を見つける場所",
    en: "Find Git-published OpenTofu Capsules",
  },
  searchPlaceholder: {
    ja: "リポジトリや Capsule を検索",
    en: "Search repositories and Capsules",
  },
  all: { ja: "すべて", en: "All" },
  apps: { ja: "アプリ", en: "Apps" },
  recentlyAdded: { ja: "新着・更新", en: "Recently updated" },
  resultsFor: { ja: "の検索結果", en: "results" },
  sortUpdated: { ja: "更新順", en: "Recently updated" },
  sortName: { ja: "名前順", en: "Name" },
  loadMore: { ja: "もっと見る", en: "Load more" },
  loading: { ja: "読み込み中…", en: "Loading…" },
  noResults: {
    ja: "該当する Capsule がありません",
    en: "No matching Capsules",
  },
  noResultsHint: {
    ja: "別のキーワードやカテゴリで探してみてください。",
    en: "Try a different keyword or category.",
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
  whereInstall: {
    ja: "あなたの Takos の URL",
    en: "Your Takos URL",
  },
  takosOriginPlaceholder: {
    ja: "https://takos.example.com",
    en: "https://takos.example.com",
  },
  change: { ja: "変更", en: "Change" },
  save: { ja: "保存", en: "Save" },
  copyLink: { ja: "リンクをコピー", en: "Copy link" },
  copied: { ja: "コピーしました", en: "Copied" },
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
  scopeEmpty: {
    ja: "このスコープにリポジトリはありません",
    en: "No repositories in this scope",
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
  refreshed: { ja: "更新しました", en: "Updated" },
  unpublish: { ja: "非公開にする", en: "Unpublish" },
  republish: { ja: "公開する", en: "Republish" },
  deleteAction: { ja: "削除", en: "Delete" },
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

/**
 * Human label for a free-form tag. Reuses the known-category labels, otherwise
 * turns "dev-tools" into "Dev Tools".
 */
export function tagLabel(tag: string, locale: Locale): string {
  const found = CATEGORY_LABELS[tag.toLowerCase()];
  if (found) return found[locale];
  return tag
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

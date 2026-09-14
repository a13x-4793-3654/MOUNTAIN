import { ReactNode } from "react";
import { makeStyles, tokens, Text, Button } from "@fluentui/react-components";
import { useLocation, useNavigate } from "react-router-dom";
import { useMsal } from "@azure/msal-react";
import Logo from "./Logo";
import SoftphoneHost from "./SoftphoneHost";
import { useAuth } from "../auth/AuthContext";
import { getRuntimeConfig } from "../auth/runtimeConfig";
import {
  Home20Regular,
  Calendar20Regular,
  DocumentBulletList20Regular,
  Building20Regular,
  Person20Regular,
  Wallet20Regular,
  Call20Regular,
  Money20Regular,
  ClipboardTaskListLtr20Regular,
  Gavel20Regular,
  DocumentFolder20Regular,
  BoxMultiple20Regular,
  Notepad20Regular,
  Settings20Regular,
  Print20Regular,
} from "@fluentui/react-icons";

const useStyles = makeStyles({
  root: {
    display: "grid",
    gridTemplateColumns: "220px minmax(0, 1fr)",
    gridTemplateRows: "48px 1fr",
    height: "100vh",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: {
    gridColumn: "1 / 3",
    display: "flex",
    alignItems: "center",
    paddingLeft: "16px",
    paddingRight: "16px",
    columnGap: "12px",
    backgroundColor: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
  },
  brand: {
    fontWeight: 700,
    fontSize: "16px",
    letterSpacing: "0.5px",
  },
  sub: {
    opacity: 0.85,
    fontSize: "12px",
  },
  userArea: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    columnGap: "10px",
  },
  userName: {
    fontSize: "13px",
    color: tokens.colorNeutralForegroundOnBrand,
  },
  signOutBtn: {
    color: tokens.colorNeutralForegroundOnBrand,
  },
  nav: {
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    paddingTop: "8px",
    overflowY: "auto",
    minHeight: 0,
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    columnGap: "10px",
    height: "40px",
    paddingLeft: "16px",
    cursor: "pointer",
    color: tokens.colorNeutralForeground1,
    fontSize: "14px",
  },
  navItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: 600,
    borderRight: `2px solid ${tokens.colorBrandStroke1}`,
  },
  navItemDisabled: {
    color: tokens.colorNeutralForegroundDisabled,
    cursor: "default",
  },
  content: {
    overflow: "auto",
    minWidth: 0,
    minHeight: 0,
    padding: "20px 24px",
  },
  calendarRoot: {
    "@media (max-width: 700px)": { gridTemplateColumns: "48px minmax(0, 1fr)" },
  },
  calendarNavItem: {
    "@media (max-width: 700px)": {
      paddingLeft: 0,
      justifyContent: "center",
      "& .fui-Text": { display: "none" },
    },
  },
  calendarContent: {
    "@media (max-width: 700px)": { padding: "16px 12px" },
  },
  calendarSub: {
    "@media (max-width: 700px)": { display: "none" },
  },
});

interface NavDef {
  key: string;
  label: string;
  icon: ReactNode;
  to?: string;
  perm?: string; // この画面を表示するのに必要な画面アクセス権
  adminOnly?: boolean; // 管理者のみ表示
}

const NAV: NavDef[] = [
  { key: "home", label: "ホーム", icon: <Home20Regular />, to: "/", perm: "screen.home" },
  { key: "calendar", label: "カレンダー", icon: <Calendar20Regular />, to: "/calendar" },
  { key: "contracts", label: "契約", icon: <DocumentBulletList20Regular />, to: "/contracts", perm: "screen.contracts" },
  { key: "billing", label: "請求・入金", icon: <Money20Regular />, to: "/billing", perm: "screen.billing" },
  { key: "review", label: "審査", icon: <ClipboardTaskListLtr20Regular />, to: "/review", perm: "screen.review" },
  { key: "companies", label: "会社", icon: <Building20Regular />, to: "/companies", perm: "screen.companies" },
  { key: "persons", label: "名義", icon: <Person20Regular />, to: "/persons", perm: "screen.persons" },
  { key: "accounts", label: "口座・カード", icon: <Wallet20Regular />, to: "/accounts", perm: "screen.accounts" },
  { key: "cti", label: "電話・CTI", icon: <Call20Regular />, to: "/cti", perm: "screen.cti" },
  { key: "litigation", label: "訴訟", icon: <Gavel20Regular />, to: "/litigation", perm: "screen.litigation" },
  { key: "files", label: "ファイル", icon: <DocumentFolder20Regular />, to: "/files", perm: "screen.files" },
  { key: "originals", label: "原本管理", icon: <BoxMultiple20Regular />, to: "/originals", perm: "screen.originals" },
  { key: "docmerge", label: "差し込み印刷", icon: <Print20Regular />, to: "/doc-templates", perm: "screen.documents" },
  { key: "docgen", label: "作成履歴", icon: <DocumentBulletList20Regular />, to: "/doc-generated", perm: "screen.documents" },
  { key: "household", label: "家計簿", icon: <Notepad20Regular />, to: "/household", perm: "screen.household" },
  { key: "admin", label: "管理", icon: <Settings20Regular />, to: "/admin", adminOnly: true },
];

export default function Layout({ children }: { children: ReactNode }) {
  const s = useStyles();
  const navigate = useNavigate();
  const loc = useLocation();
  const isCalendar = loc.pathname === "/calendar";
  const { can, me } = useAuth();

  // 画面アクセス権のあるメニューだけを表示（管理者はすべて表示）
  const items = NAV.filter((n) => {
    if (n.adminOnly) return !!me?.is_admin;
    if (!n.perm) return true;
    return can(n.perm);
  });

  return (
    <div className={`${s.root} ${isCalendar ? s.calendarRoot : ""}`}>
      <div className={s.header}>
        <Logo size={24} />
        <span className={s.brand}>MOUNTAIN</span>
        <span className={`${s.sub} ${isCalendar ? s.calendarSub : ""}`}>債権・家計管理システム</span>
        <UserMenu />
      </div>
      <nav className={s.nav}>
        {items.map((n) => {
          const active =
            n.to === "/"
              ? loc.pathname === "/"
              : n.to && loc.pathname.startsWith(n.to);
          const cls = `${s.navItem} ${active ? s.navItemActive : ""} ${
            n.to ? "" : s.navItemDisabled
          }`;
          return (
            <div
              key={n.key}
              className={`${cls} ${isCalendar ? s.calendarNavItem : ""}`}
              role="link"
              aria-label={n.label}
              tabIndex={n.to ? 0 : undefined}
              aria-current={active ? "page" : undefined}
              onKeyDown={(event) => {
                if (n.to && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  navigate(n.to);
                }
              }}
              onClick={() => n.to && navigate(n.to)}
              title={n.to ? n.label : `${n.label}（今後実装予定）`}
            >
              {n.icon}
              <Text>{n.label}</Text>
            </div>
          );
        })}
      </nav>
      <main className={`${s.content} ${isCalendar ? s.calendarContent : ""}`}>{children}</main>
      <SoftphoneHost />
    </div>
  );
}

function UserMenu() {
  const s = useStyles();
  const { me } = useAuth();
  const { instance } = useMsal();
  const cfg = getRuntimeConfig();

  const signOut = () => {
    void instance.logoutPopup();
  };

  return (
    <div className={s.userArea}>
      {me && (
        <Text className={s.userName}>
          {me.display_name}
          {me.is_admin ? "（管理者）" : ""}
        </Text>
      )}
      {cfg.auth_enabled && (
        <Button
          size="small"
          appearance="subtle"
          className={s.signOutBtn}
          onClick={signOut}
        >
          サインアウト
        </Button>
      )}
    </div>
  );
}

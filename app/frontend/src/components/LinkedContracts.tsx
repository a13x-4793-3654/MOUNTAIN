import { useNavigate } from "react-router-dom";
import {
  makeStyles,
  tokens,
  Badge,
  Table,
  TableHeader,
  TableHeaderCell,
  TableRow,
  TableBody,
  TableCell,
  Button,
} from "@fluentui/react-components";
import { Open16Regular } from "@fluentui/react-icons";
import { LinkedContract } from "../api/client";
import { statusAppearance } from "../util/format";

const useStyles = makeStyles({
  no: { fontVariantNumeric: "tabular-nums", fontWeight: 600 },
  row: { cursor: "pointer" },
  empty: { color: tokens.colorNeutralForeground3 },
});

export default function LinkedContracts({
  contracts,
}: {
  contracts: LinkedContract[];
}) {
  const s = useStyles();
  const navigate = useNavigate();
  return (
    <Table aria-label="関連する契約" size="small">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>契約番号</TableHeaderCell>
          <TableHeaderCell>概要</TableHeaderCell>
          <TableHeaderCell>状態</TableHeaderCell>
          <TableHeaderCell>関係</TableHeaderCell>
          <TableHeaderCell />
        </TableRow>
      </TableHeader>
      <TableBody>
        {contracts.map((c) => (
          <TableRow
            key={c.id + (c.link_category ?? "")}
            className={s.row}
            onClick={() => navigate(`/contracts/${c.id}`)}
          >
            <TableCell className={s.no}>{c.contract_no}</TableCell>
            <TableCell>{c.contract_summary ?? "—"}</TableCell>
            <TableCell>
              <Badge appearance="filled" color={statusAppearance(c.contract_status)}>
                {c.status_label ?? c.contract_status}
              </Badge>
            </TableCell>
            <TableCell>
              {c.link_label ?? c.link_category ?? "—"}
              {c.is_default ? "（既定）" : ""}
            </TableCell>
            <TableCell>
              <Button
                size="small"
                appearance="subtle"
                icon={<Open16Regular />}
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/contracts/${c.id}`);
                }}
              >
                開く
              </Button>
            </TableCell>
          </TableRow>
        ))}
        {contracts.length === 0 && (
          <TableRow>
            <TableCell colSpan={5} className={s.empty}>
              関連する契約はありません。
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

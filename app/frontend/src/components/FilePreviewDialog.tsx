import { useEffect, useState } from "react";
import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Spinner,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { ArrowDownload20Regular } from "@fluentui/react-icons";
import { fetchFileBlob, downloadFileContent } from "../api/client";
import { fileTypeLabel } from "../util/format";

type Kind = "pdf" | "image" | "text" | "other";

function kindOf(contentType: string | null | undefined, fileName: string): Kind {
  const ct = (contentType ?? "").toLowerCase();
  const name = (fileName ?? "").toLowerCase();
  if (ct === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/.test(name)) return "image";
  if (ct === "text/plain" || ct === "text/csv" || /\.(txt|csv)$/.test(name)) return "text";
  return "other";
}

export default function FilePreviewDialog({
  open,
  fileId,
  fileName,
  contentType,
  onClose,
}: {
  open: boolean;
  fileId: string | null;
  fileName: string;
  contentType: string | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [textBody, setTextBody] = useState<string | null>(null);

  const kind = kindOf(contentType, fileName);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    async function run() {
      if (!open || !fileId) return;
      setLoading(true);
      setError(null);
      setUrl(null);
      setTextBody(null);
      try {
        const blob = await fetchFileBlob(fileId);
        if (cancelled) return;
        if (kind === "text") {
          const t = await blob.text();
          if (cancelled) return;
          setTextBody(t.length > 200000 ? t.slice(0, 200000) + "\n…（以下省略）" : t);
        } else if (kind === "pdf" || kind === "image") {
          const objUrl = URL.createObjectURL(blob);
          revoked = objUrl;
          setUrl(objUrl);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "プレビューを表示できませんでした");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fileId]);

  async function onDownload() {
    if (!fileId) return;
    try {
      await downloadFileContent(fileId, fileName || "download");
    } catch (e: any) {
      setError(e?.message ?? "ダウンロードに失敗しました");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: "min(96vw, 1040px)", width: "min(96vw, 1040px)" }}>
        <DialogBody>
          <DialogTitle>{fileName || "プレビュー"}</DialogTitle>
          <DialogContent>
            {error && (
              <MessageBar intent="error" style={{ marginBottom: 12 }}>
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            )}
            {loading && (
              <div style={{ padding: 32, textAlign: "center" }}>
                <Spinner label="読み込み中…" />
              </div>
            )}
            {!loading && !error && (
              <div style={{ minHeight: 120 }}>
                {kind === "pdf" && url && (
                  <iframe
                    title="preview"
                    src={url}
                    style={{ width: "100%", height: "72vh", border: "1px solid #e0e0e0", borderRadius: 6 }}
                  />
                )}
                {kind === "image" && url && (
                  <div style={{ textAlign: "center" }}>
                    <img
                      src={url}
                      alt={fileName}
                      style={{ maxWidth: "100%", maxHeight: "72vh", objectFit: "contain" }}
                    />
                  </div>
                )}
                {kind === "text" && textBody !== null && (
                  <pre
                    style={{
                      maxHeight: "72vh",
                      overflow: "auto",
                      background: "#f7f7f7",
                      border: "1px solid #e0e0e0",
                      borderRadius: 6,
                      padding: 12,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      fontSize: 13,
                    }}
                  >
                    {textBody}
                  </pre>
                )}
                {kind === "other" && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      この形式（{fileTypeLabel(contentType)}）はブラウザ上でプレビューできません。
                      「ダウンロード」から保存してご確認ください。
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" icon={<ArrowDownload20Regular />} onClick={onDownload}>
              ダウンロード
            </Button>
            <Button appearance="primary" onClick={onClose}>
              閉じる
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

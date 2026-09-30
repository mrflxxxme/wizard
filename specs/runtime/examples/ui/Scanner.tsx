import { AppShell, QrScanner } from "@wizard/ui-kit";

// Офлайн-пакет билетов, очередь отметок и синхронизацию ведёт компонент через qr-коннектор (M2).
export default function Scanner() {
  return (
    <AppShell title="Сканер билетов">
      <QrScanner integration="qr" gate="Вход А" offline />
    </AppShell>
  );
}

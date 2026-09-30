import { AppShell, QrScanner } from "@wizard/ui-kit";

// Проверка — служебный /_wizard/qr/check; офлайн-манифест, очередь и синхронизация — в компоненте (M2, connectors/qr.yaml).
export default function Scanner() {
  return (
    <AppShell title="Сканер билетов">
      <QrScanner checkpoint="Вход А" offline />
    </AppShell>
  );
}

// M0-08: placeholders with final prop types; implementations land in M0-25.
import type { ReactNode } from "react";
import { useWzRoot, type WzBase } from "../data/context.js";
import type { Rec } from "../data/types.js";
import type {
  CabinetLayoutProps,
  CatalogProps,
  ConsentCheckboxProps,
  DataTableProps,
  ItemCardProps,
  QrScannerProps,
  QrTicketProps,
  RecordCardProps,
  RecordFormProps,
  StatsReportProps,
  StatusBoardProps,
} from "./types.js";

function Stub({ name, testBase, props }: { name: string; testBase: string; props: WzBase }): ReactNode {
  const root = useWzRoot(name, testBase, props);
  return <div {...root} className={props.className} data-wz-stub="true" />;
}

export const Catalog = <T = Rec>(p: CatalogProps<T>) => (
  <Stub name="Catalog" testBase="wz-catalog" props={p} />
);
export const ItemCard = (p: ItemCardProps) => <Stub name="ItemCard" testBase="wz-itemcard" props={p} />;
export const RecordForm = (p: RecordFormProps) => (
  <Stub name="RecordForm" testBase="wz-recordform" props={p} />
);
export const DataTable = <T = Rec>(p: DataTableProps<T>) => (
  <Stub name="DataTable" testBase="wz-datatable" props={p} />
);
export const RecordCard = <T = Rec>(p: RecordCardProps<T>) => (
  <Stub name="RecordCard" testBase="wz-recordcard" props={p} />
);
export const StatusBoard = <T = Rec>(p: StatusBoardProps<T>) => (
  <Stub name="StatusBoard" testBase="wz-statusboard" props={p} />
);
export const QrTicket = (p: QrTicketProps) => <Stub name="QrTicket" testBase="wz-qrticket" props={p} />;
export const QrScanner = (p: QrScannerProps) => <Stub name="QrScanner" testBase="wz-qrscanner" props={p} />;
export const CabinetLayout = (p: CabinetLayoutProps) => (
  <Stub name="CabinetLayout" testBase="wz-cabinet" props={p} />
);
export const StatsReport = (p: StatsReportProps) => <Stub name="StatsReport" testBase="wz-stats" props={p} />;
export const ConsentCheckbox = (p: ConsentCheckboxProps) => (
  <Stub name="ConsentCheckbox" testBase="wz-consent" props={p} />
);

import {
  BarChart3,
  Braces,
  Code2,
  Database,
  FileText,
  FlaskConical,
  Network,
  PenTool,
  Route,
  ScanSearch,
  Search,
  ShieldCheck,
  UserRound,
  type LucideIcon
} from 'lucide-react';

const iconMap: Record<string, LucideIcon> = {
  chart: BarChart3,
  code: Code2,
  database: Database,
  file: FileText,
  flask: FlaskConical,
  network: Network,
  pen: PenTool,
  route: Route,
  scan: ScanSearch,
  search: Search,
  shield: ShieldCheck,
  braces: Braces,
  user: UserRound
};

export function AgentGlyph({ iconKey, size = 24, strokeWidth = 1.7 }: { iconKey: string; size?: number; strokeWidth?: number }) {
  const Icon = iconMap[iconKey] ?? Braces;
  return <Icon aria-hidden="true" size={size} strokeWidth={strokeWidth} />;
}

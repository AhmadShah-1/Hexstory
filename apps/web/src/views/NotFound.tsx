import { Panel } from '../components/Panel';

export function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <Panel title="Not found">
      <p className="pad">This {what} doesn't exist, or it was removed.</p>
    </Panel>
  );
}

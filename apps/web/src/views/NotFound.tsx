import { ApiError, errorMessage } from '../api/client';
import { Panel } from '../components/Panel';

export function NotFound({ what = 'page' }: { what?: string }) {
  return (
    <Panel title="Not found">
      <p className="pad">This {what} doesn't exist, or it was removed.</p>
    </Panel>
  );
}

/** For a failed load: "not found" only when the server said so, otherwise a retryable error. */
export function LoadFailed({ error, what, retry }: { error: unknown; what: string; retry: () => void }) {
  if (error instanceof ApiError && (error.status === 404 || error.status === 403)) return <NotFound what={what} />;
  return (
    <Panel title="Couldn't load">
      <div className="pad">
        <p>{errorMessage(error)}</p>
        <div className="action-row">
          <button className="button" onClick={retry}>Try again</button>
        </div>
      </div>
    </Panel>
  );
}

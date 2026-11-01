import { useState } from 'react';
import { TRUST_NAMES, displayNameSchema } from '@hexstory/shared';
import { errorMessage } from '../api/client';
import { useDeleteAccount, useSession, useSignOut, useUpdateProfile } from '../api/queries';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';

export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const user = useSession().data?.user;
  const update = useUpdateProfile();
  const signOut = useSignOut();
  const remove = useDeleteAccount();
  const toast = useToast();
  const [name, setName] = useState(user?.displayName ?? '');
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  if (!user) return null;

  const saveName = () => {
    const parsed = displayNameSchema.safeParse(name);
    if (!parsed.success) return toast(parsed.error.issues[0]?.message ?? 'Invalid name');
    update.mutate({ displayName: parsed.data }, { onSuccess: () => toast('Name updated') });
  };

  return (
    <Modal open={open} onClose={onClose} title="Your account">
      <p className="muted small">
        {TRUST_NAMES[user.trustLevel]} · joined {new Date(user.createdAt).toLocaleDateString()}
      </p>
      <label className="field">
        <span>Public name</span>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
          <button className="button" onClick={saveName} disabled={update.isPending || name === user.displayName}>Save</button>
        </div>
      </label>
      {update.error && <p className="error-text">{errorMessage(update.error)}</p>}

      <div className="row-end">
        <button className="button" onClick={() => signOut.mutate()}>Sign out</button>
      </div>

      <details className="danger-zone">
        <summary>Delete account</summary>
        <p className="small">
          Your name and email are removed and you are signed out everywhere. Stories and edits you made stay on
          Hexstory (they're shared under CC BY-SA 4.0) but will show “Deleted user”.
        </p>
        {confirming ? (
          <div className="row">
            <input placeholder='Type "delete"' value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            <button className="button button-danger" disabled={confirmText !== 'delete' || remove.isPending} onClick={() => remove.mutate()}>
              Delete forever
            </button>
          </div>
        ) : (
          <button className="button button-danger" onClick={() => setConfirming(true)}>Delete my account</button>
        )}
      </details>
    </Modal>
  );
}

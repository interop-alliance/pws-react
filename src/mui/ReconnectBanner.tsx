/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The storage-access-expired banner (wallet mode). Shown when a live 401/403
 * from the PWS server surfaces on the sync error stream (the granted zcaps
 * expired or were revoked); the action relaunches the grants flow with the
 * existing seed (one wallet popup, same identity, same data).
 */
import { Alert, Button } from '@mui/material'
import { useReconnect } from '../react/hooks.js'

export function ReconnectBanner() {
  const { accessExpired, reconnecting, reconnect } = useReconnect()

  if (!accessExpired) {
    return null
  }

  return (
    <Alert
      severity="warning"
      data-testid="reconnect-banner"
      sx={{ mb: 2 }}
      action={
        <Button
          color="inherit"
          size="small"
          disabled={reconnecting}
          onClick={() => void reconnect()}
          data-testid="reconnect-wallet"
        >
          {reconnecting ? 'Reconnecting...' : 'Reconnect wallet'}
        </Button>
      }
    >
      Storage access expired -- reconnect your wallet to keep syncing.
    </Alert>
  )
}

/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The router gate: a thin switch over the app's `onboarding` mode. While the
 * session is booting it shows a spinner; a `local-first` app then always renders
 * the routed pages (over the anonymous replica), while a `login-gated` app
 * renders them only once the wallet is connected and otherwise redirects to the
 * login path. Uses react-router's `Navigate` / `Outlet`.
 *
 * Boot is kicked off by {@link PwsSessionProvider} on mount, not here, so a
 * local-first app that never mounts this component still boots.
 *
 * The fatal-error alert (`data-testid="bootstrap-error"`) is scoped to
 * boot/storage failures ONLY: it renders solely while `status === 'boot'` with
 * an `error`, which the store only produces when even the anonymous local
 * replica cannot be opened. A failed or cancelled wallet login (or a reconnect
 * failure) sets the store's `error` too, but only after `status` has left `boot`
 * (to `local` / `reconnect`), so it never blanks a local-first app with this
 * alert -- the login page surfaces that error instead.
 */
import { Navigate, Outlet } from 'react-router'
import { Alert, Box, CircularProgress, Typography } from '@mui/material'
import { useSession } from '../react/hooks.js'

function CenteredSpinner({ label }: { label: string }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        minHeight: '60vh'
      }}
      data-testid="bootstrap-loading"
    >
      <CircularProgress />
      <Typography color="text.secondary">{label}</Typography>
    </Box>
  )
}

/**
 * @param props {object}
 * @param [props.loginPath] {string}   where to send a not-yet-connected visitor
 *   in a login-gated app (defaults to `/login`)
 * @returns {ReactNode}
 */
export function ProtectedRoute({
  loginPath = '/login'
}: {
  loginPath?: string
} = {}) {
  const { status, onboarding, error } = useSession()

  // Only a boot/storage failure (error present while still in `boot`) replaces
  // the app with the fatal alert; a login/reconnect error never reaches here.
  if (status === 'boot' && error) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error" data-testid="bootstrap-error">
          Failed to open local storage: {error}
        </Alert>
      </Box>
    )
  }

  if (status === 'boot') {
    return <CenteredSpinner label="Loading..." />
  }
  if (onboarding === 'local-first') {
    return <Outlet />
  }
  // login-gated: the app is reachable only once a wallet is connected.
  if (status === 'connected' || status === 'reconnect') {
    return <Outlet />
  }
  return <Navigate to={loginPath} replace />
}

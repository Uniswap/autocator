import { ConnectButton } from '@rainbow-me/rainbowkit';

interface WalletConnectProps {
  hasSession: boolean;
}

export function WalletConnect({ hasSession }: WalletConnectProps) {
  return (
    <div className="flex items-center justify-end">
      <ConnectButton
        showBalance={hasSession}
        accountStatus={{ smallScreen: 'avatar', largeScreen: 'full' }}
        chainStatus={{ smallScreen: 'icon', largeScreen: 'full' }}
      />
    </div>
  );
}

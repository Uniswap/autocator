import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import '@rainbow-me/rainbowkit/styles.css';
import { useState } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  useLocation,
} from 'react-router-dom';

import { config } from './config/wagmi';
import { WalletConnect } from './components/WalletConnect';
import { BalanceDisplay } from './components/BalanceDisplay';
import HealthCheck from './components/HealthCheck';
import { DepositForm } from './components/DepositForm';
import { NotificationProvider } from './context/NotificationProvider';
import { AllocatorConfigProvider } from './contexts/AllocatorConfigProvider';
import APISection from './components/APISection';
import AllocatorAdmin from './components/AllocatorAdmin';

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: Infinity,
      refetchOnWindowFocus: false,
    },
  },
});

const customTheme = darkTheme({
  accentColor: '#00ff00',
  accentColorForeground: '#000000',
  borderRadius: 'medium',
  overlayBlur: 'small',
});

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isAdmin = location.pathname === '/admin';

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0a]">
      <header className="flex-none bg-[#0a0a0a] border-b border-gray-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div>
            <Link to="/">
              <h1 className="text-3xl font-black font-monaco">
                <span className="text-[#00ff00]">Auto</span>
                <span className="text-white">cator</span>
                <span className="text-white"> 🚗</span>
              </h1>
            </Link>
            <p className="text-gray-400 text-sm mt-1">
              A server-based allocator for{' '}
              <a
                href="https://github.com/Uniswap/the-compact"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#00ff00] hover:underline"
              >
                The Compact
              </a>{' '}
              🤝
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link
              to={isAdmin ? '/' : '/admin'}
              className="text-gray-400 hover:text-[#00ff00] transition-colors text-sm"
            >
              {isAdmin ? '← Back to App' : 'Admin'}
            </Link>
            <a
              href="https://github.com/Uniswap/autocator"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-[#00ff00] transition-colors"
            >
              <svg
                viewBox="0 0 24 24"
                width="24"
                height="24"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path>
              </svg>
            </a>
            <WalletConnect />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {children}
        </div>
      </main>
    </div>
  );
}

function HomePage() {
  const [isHealthy, setIsHealthy] = useState(true);

  return (
    <div className="space-y-6">
      {/* Health Check Status */}
      <div className="mx-auto p-4 bg-[#0a0a0a] rounded-lg shadow-xl border border-gray-800">
        <HealthCheck onHealthStatusChange={setIsHealthy} />
      </div>

      {/* Only show these components if the server is healthy */}
      {isHealthy && (
        <>
          {/* Deposit Form */}
          <DepositForm />

          {/* Balance Display */}
          <div className="mx-auto p-6 bg-[#0a0a0a] rounded-lg shadow-xl border border-gray-800">
            <BalanceDisplay />
          </div>
        </>
      )}

      {/* API Section - always visible */}
      <APISection />
    </div>
  );
}

function AdminPage() {
  return <AllocatorAdmin />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <Layout>
            <HomePage />
          </Layout>
        }
      />
      <Route
        path="/admin"
        element={
          <Layout>
            <AdminPage />
          </Layout>
        }
      />
    </Routes>
  );
}

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={customTheme}>
          <NotificationProvider>
            <AllocatorConfigProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </AllocatorConfigProvider>
          </NotificationProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

export default App;

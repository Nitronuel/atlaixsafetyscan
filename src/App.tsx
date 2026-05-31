import React from 'react';
import { SafefyScan } from './pages/SafefyScan';

export default function App() {
  return (
    <main className="min-h-screen bg-main px-4 py-6 text-text-light sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px]">
        <SafefyScan />
      </div>
    </main>
  );
}

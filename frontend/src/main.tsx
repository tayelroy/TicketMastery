import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import './app/styles.css';
import { configureAuth } from './auth/amplify';
import { AuthProvider } from './auth/AuthContext';
import { router } from './router';

configureAuth(); // before anything calls Amplify

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);

import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './app/Layout';
import { NotFoundPage } from './app/NotFoundPage';
import { AUTH_MODE } from './auth/amplify';
import { CognitoLoginPage } from './auth/CognitoLoginPage';
import { DevLoginPage } from './auth/DevLoginPage';
import { features } from './features';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      ...features.flatMap((f) => f.routes),
      { path: '/login', element: AUTH_MODE === 'cognito' ? <CognitoLoginPage /> : <DevLoginPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

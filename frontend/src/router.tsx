import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './app/Layout';
import { NotFoundPage } from './app/NotFoundPage';
import { DevLoginPage } from './auth/DevLoginPage';
import { features } from './features';

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      ...features.flatMap((f) => f.routes),
      { path: '/login', element: <DevLoginPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

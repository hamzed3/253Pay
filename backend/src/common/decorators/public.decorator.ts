import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Ouvre une route sans authentification.
 *
 * POURQUOI ce sens-là : le JwtAuthGuard est GLOBAL. Tout est donc protégé par
 * défaut, et l'on ouvre explicitement les rares exceptions. L'inverse — tout
 * ouvert, et l'on protège au cas par cas — laisse tôt ou tard passer une route
 * oubliée. Sur une API financière, cet oubli-là coûte cher.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

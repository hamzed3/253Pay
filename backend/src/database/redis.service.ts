import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Connexion Redis — la mémoire courte.
 * OTP qui expirent, compteurs de tentatives, verrous, files d'attente.
 * Aucune donnée financière ne vit ici : Redis peut être vidé sans conséquence.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    this.client.on('connect', () => this.logger.log('Redis connecté'));
    this.client.on('error', (error) => this.logger.error(`Redis : ${error.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  getClient(): Redis {
    return this.client;
  }

  /** Utilisé par /health. */
  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}

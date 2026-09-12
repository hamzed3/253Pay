import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, Matches, MaxLength } from 'class-validator';

/** Aucun champ `fee` ni `credited` : le serveur les calcule (règle n°3). */
export class QuoteDepositDto {
  @ApiProperty({ example: '10000', description: 'Montant remis, en FDJ' })
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'Montant invalide : chiffres attendus, au maximum 2 décimales.',
  })
  amount!: string;
}

export class CreateDepositDto extends QuoteDepositDto {
  @ApiProperty({ example: '77123456', description: 'Compte chez le partenaire' })
  @IsNotEmpty()
  @MaxLength(64)
  account!: string;

  @ApiPropertyOptional({ example: 'MOCK', description: 'Code du partenaire' })
  @IsOptional()
  // Volontairement restreint à la liste des partenaires existants : un code
  // libre laisserait un client sonder les intégrations disponibles.
  @IsIn(['MOCK'])
  provider?: string;
}

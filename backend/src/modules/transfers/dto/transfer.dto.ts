import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * Remarquez ce qui N'EST PAS dans ces DTO : aucun champ `fee`, aucun `total`,
 * aucun `senderWalletId`.
 *
 * Le client dit à qui et combien. Le serveur décide de tout le reste — frais,
 * plafonds, comptes à mouvementer. C'est la règle absolue n°3, et la parade au
 * risque n°6 (montant manipulé côté mobile). La validation étant en mode
 * `forbidNonWhitelisted`, envoyer `"fee": 0` fait échouer la requête.
 */
export class QuoteTransferDto {
  @ApiProperty({ example: '77123456', description: 'Numéro du bénéficiaire' })
  @IsNotEmpty()
  @MaxLength(20)
  recipientPhone!: string;

  @ApiProperty({ example: '5000', description: 'Montant en FDJ, au maximum 2 décimales' })
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'Montant invalide : chiffres attendus, au maximum 2 décimales.',
  })
  amount!: string;
}

export class CreateTransferDto extends QuoteTransferDto {
  @ApiProperty({ example: '7391', description: 'Code secret, pour confirmer l’opération' })
  @IsNumberString()
  @Length(4, 6)
  pin!: string;

  @ApiProperty({ example: 'Loyer de septembre', required: false })
  @IsOptional()
  @MaxLength(140)
  note?: string;
}

export class ReverseTransferDto {
  @ApiProperty({ example: 'Erreur de saisie signalée par le client' })
  @IsNotEmpty()
  @MaxLength(255)
  reason!: string;
}

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum EmailStatus {
  QUEUED = 'queued',
  SENT = 'sent',
  FAILED = 'failed',
}

/**
 * The table is created by CreateEmailLogsTable1772200000000 with snake_case
 * column names. This project has no global snake_case naming strategy, so
 * every column that does not line up with the migrated name needs an explicit
 * `name` override — otherwise TypeORM emits SQL against the camelCase property
 * name and Postgres rejects it.
 */
@Entity('email_logs')
@Index('IDX_email_logs_status', ['status'])
@Index('IDX_email_logs_user_id', ['userId'])
export class EmailLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', nullable: true })
  userId: string | null;

  @Column()
  to: string;

  @Column({ name: 'template_alias' })
  templateAlias: string;

  @Column()
  subject: string;

  @Column({ type: 'enum', enum: EmailStatus, default: EmailStatus.QUEUED })
  status: EmailStatus;

  @Column({ name: 'provider_message_id', nullable: true })
  providerMessageId: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'attempt_count', default: 0 })
  attemptCount: number;

  @Column({ name: 'sent_at', nullable: true })
  sentAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

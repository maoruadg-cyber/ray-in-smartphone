"""消費税管理のテスト"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from datetime import date
from decimal import Decimal

import pytest

from src.consumption_tax import (
    ConsumptionTaxManager,
    ConsumptionTaxCalculator,
    TaxCategory,
    TransactionType,
    PurchaseUsage,
    Transaction,
)


# ------------------------------------------------------------------ #
# Transaction モデルのテスト                                           #
# ------------------------------------------------------------------ #

class TestTransaction:
    def test_standard_rate_tax(self):
        tx = Transaction(
            transaction_date=date(2025, 5, 1),
            description="国内販売",
            amount_excl_tax=Decimal("100000"),
            tax_category=TaxCategory.STANDARD_RATE,
            transaction_type=TransactionType.SALES,
        )
        assert tx.tax_rate == Decimal("0.10")
        assert tx.tax_amount == Decimal("10000")
        assert tx.amount_incl_tax == Decimal("110000")

    def test_reduced_rate_tax(self):
        tx = Transaction(
            transaction_date=date(2025, 5, 1),
            description="食品販売",
            amount_excl_tax=Decimal("50000"),
            tax_category=TaxCategory.REDUCED_RATE,
            transaction_type=TransactionType.SALES,
        )
        assert tx.tax_rate == Decimal("0.08")
        assert tx.tax_amount == Decimal("4000")

    def test_export_exempt_no_tax(self):
        tx = Transaction(
            transaction_date=date(2025, 5, 1),
            description="輸出販売",
            amount_excl_tax=Decimal("200000"),
            tax_category=TaxCategory.EXPORT_EXEMPT,
            transaction_type=TransactionType.SALES,
        )
        assert tx.tax_rate == Decimal("0.00")
        assert tx.tax_amount == Decimal("0")
        assert tx.amount_incl_tax == Decimal("200000")

    def test_qualified_invoice_detection(self):
        with_invoice = Transaction(
            transaction_date=date(2025, 5, 1),
            description="仕入",
            amount_excl_tax=Decimal("10000"),
            tax_category=TaxCategory.STANDARD_RATE,
            transaction_type=TransactionType.PURCHASE,
            invoice_number="T1234567890123",
        )
        without_invoice = Transaction(
            transaction_date=date(2025, 5, 1),
            description="仕入（インボイスなし）",
            amount_excl_tax=Decimal("10000"),
            tax_category=TaxCategory.STANDARD_RATE,
            transaction_type=TransactionType.PURCHASE,
        )
        assert with_invoice.is_qualified_invoice is True
        assert without_invoice.is_qualified_invoice is False

    def test_creditable_tax_without_invoice_is_80_percent(self):
        """インボイスなし仕入は国税分の80%控除（経過措置）"""
        tx = Transaction(
            transaction_date=date(2025, 5, 1),
            description="仕入（インボイスなし）",
            amount_excl_tax=Decimal("100000"),
            tax_category=TaxCategory.STANDARD_RATE,
            transaction_type=TransactionType.PURCHASE,
        )
        assert tx.tax_amount == Decimal("10000")          # 請求書表示用: 100,000 × 10%
        assert tx.national_tax_amount == Decimal("7800")  # 国税分: 100,000 × 7.8%
        assert tx.creditable_tax_amount == Decimal("6240")  # 7800 × 80%

    def test_creditable_tax_with_invoice_is_full(self):
        """インボイスあり仕入は国税分（7.8%）を全額控除"""
        tx = Transaction(
            transaction_date=date(2025, 5, 1),
            description="仕入",
            amount_excl_tax=Decimal("100000"),
            tax_category=TaxCategory.STANDARD_RATE,
            transaction_type=TransactionType.PURCHASE,
            invoice_number="T1234567890123",
        )
        assert tx.creditable_tax_amount == Decimal("7800")  # 100,000 × 7.8%


# ------------------------------------------------------------------ #
# 課税売上割合のテスト                                                  #
# ------------------------------------------------------------------ #

class TestTaxableRatio:
    def setup_method(self):
        self.calc = ConsumptionTaxCalculator()

    def _make_sales(self, domestic: int, export: int, non_taxable: int):
        txs = []
        if domestic:
            txs.append(Transaction(
                transaction_date=date(2025, 5, 1),
                description="国内",
                amount_excl_tax=Decimal(domestic),
                tax_category=TaxCategory.STANDARD_RATE,
                transaction_type=TransactionType.SALES,
            ))
        if export:
            txs.append(Transaction(
                transaction_date=date(2025, 5, 1),
                description="輸出",
                amount_excl_tax=Decimal(export),
                tax_category=TaxCategory.EXPORT_EXEMPT,
                transaction_type=TransactionType.SALES,
            ))
        if non_taxable:
            txs.append(Transaction(
                transaction_date=date(2025, 5, 1),
                description="非課税",
                amount_excl_tax=Decimal(non_taxable),
                tax_category=TaxCategory.NON_TAXABLE,
                transaction_type=TransactionType.SALES,
            ))
        return txs

    def test_export_sales_included_in_taxable_ratio(self):
        """輸出売上は課税売上割合の分子に含まれる"""
        txs = self._make_sales(domestic=500_000, export=500_000, non_taxable=0)
        summary = self.calc.summarize_sales(txs)
        assert summary.taxable_sales_ratio == Decimal("1.0000")

    def test_ratio_with_non_taxable(self):
        """非課税売上がある場合の課税売上割合"""
        txs = self._make_sales(domestic=800_000, export=0, non_taxable=200_000)
        summary = self.calc.summarize_sales(txs)
        assert summary.taxable_sales_ratio == Decimal("0.8000")

    def test_all_export_ratio_is_100_percent(self):
        """輸出のみなら課税売上割合100%"""
        txs = self._make_sales(domestic=0, export=1_000_000, non_taxable=0)
        summary = self.calc.summarize_sales(txs)
        assert summary.taxable_sales_ratio == Decimal("1.0000")


# ------------------------------------------------------------------ #
# 仕入税額控除のテスト                                                  #
# ------------------------------------------------------------------ #

class TestInputTaxCredit:
    def setup_method(self):
        self.calc = ConsumptionTaxCalculator()

    def test_full_credit_when_ratio_over_95(self):
        """課税売上割合95%以上は全額控除"""
        txs = [
            Transaction(
                transaction_date=date(2025, 5, 1),
                description="国内売上",
                amount_excl_tax=Decimal("1_000_000"),
                tax_category=TaxCategory.STANDARD_RATE,
                transaction_type=TransactionType.SALES,
                invoice_number="T0000000000001",
            ),
            Transaction(
                transaction_date=date(2025, 5, 1),
                description="仕入",
                amount_excl_tax=Decimal("500_000"),
                tax_category=TaxCategory.STANDARD_RATE,
                transaction_type=TransactionType.PURCHASE,
                invoice_number="T0000000000002",
            ),
        ]
        result = self.calc.calculate(txs)
        assert result.taxable_sales_ratio == Decimal("1.0000")
        # 仕入税額控除は国税分 500,000 × 7.8% = 39,000（全額）
        assert result.input_tax_credit == Decimal("39000")
        assert "全額控除" in result.credit_method

    def test_proportional_method_when_ratio_under_95(self):
        """課税売上割合が95%未満は按分"""
        txs = [
            Transaction(
                transaction_date=date(2025, 5, 1),
                description="国内売上",
                amount_excl_tax=Decimal("600_000"),
                tax_category=TaxCategory.STANDARD_RATE,
                transaction_type=TransactionType.SALES,
            ),
            Transaction(
                transaction_date=date(2025, 5, 1),
                description="非課税売上（利息）",
                amount_excl_tax=Decimal("400_000"),
                tax_category=TaxCategory.NON_TAXABLE,
                transaction_type=TransactionType.SALES,
            ),
            Transaction(
                transaction_date=date(2025, 5, 1),
                description="仕入",
                amount_excl_tax=Decimal("200_000"),
                tax_category=TaxCategory.STANDARD_RATE,
                transaction_type=TransactionType.PURCHASE,
                invoice_number="T0000000000002",
            ),
        ]
        result = self.calc.calculate(txs, use_individual_method=False)
        assert result.taxable_sales_ratio == Decimal("0.6000")
        # 仕入税額（国税分）200,000 × 7.8% = 15,600 → × 60% = 9,360
        assert result.input_tax_credit == Decimal("9360")

    def test_individual_method(self):
        """個別対応方式"""
        txs = [
            Transaction(
                transaction_date=date(2025, 5, 1),
                description="国内売上",
                amount_excl_tax=Decimal("600_000"),
                tax_category=TaxCategory.STANDARD_RATE,
                transaction_type=TransactionType.SALES,
            ),
            Transaction(
                transaction_date=date(2025, 5, 1),
                description="非課税売上",
                amount_excl_tax=Decimal("400_000"),
                tax_category=TaxCategory.NON_TAXABLE,
                transaction_type=TransactionType.SALES,
            ),
            # 課税売上専用仕入（全額控除）
            Transaction(
                transaction_date=date(2025, 5, 1),
                description="課税売上用仕入",
                amount_excl_tax=Decimal("100_000"),
                tax_category=TaxCategory.STANDARD_RATE,
                transaction_type=TransactionType.PURCHASE,
                invoice_number="T0000000000002",
                purchase_usage=PurchaseUsage.TAXABLE_ONLY,
            ),
            # 共通仕入（按分）
            Transaction(
                transaction_date=date(2025, 5, 1),
                description="共通仕入",
                amount_excl_tax=Decimal("100_000"),
                tax_category=TaxCategory.STANDARD_RATE,
                transaction_type=TransactionType.PURCHASE,
                invoice_number="T0000000000003",
                purchase_usage=PurchaseUsage.COMMON,
            ),
        ]
        result = self.calc.calculate(txs, use_individual_method=True)
        # 課税対応 100,000 × 7.8% = 7,800 全額
        # + 共通 100,000 × 7.8% = 7,800 × 60% = 4,680
        # 合計 12,480
        assert result.input_tax_credit == Decimal("12480")


# ------------------------------------------------------------------ #
# ConsumptionTaxManager の統合テスト                                   #
# ------------------------------------------------------------------ #

class TestConsumptionTaxManager:
    def setup_method(self):
        self.manager = ConsumptionTaxManager()

    def test_add_and_retrieve_transactions(self):
        self.manager.add_domestic_sale(
            date(2025, 5, 10), "商品A販売", Decimal("100000"),
            invoice_number="T0000000000001",
        )
        self.manager.add_export_sale(
            date(2025, 5, 15), "海外向け輸出", Decimal("200000"), partner_name="Overseas Co."
        )
        txs = self.manager.get_transactions()
        assert len(txs) == 2

    def test_export_and_domestic_scenario(self):
        """輸出販売と国内販売の混在シナリオ"""
        # 売上
        self.manager.add_domestic_sale(
            date(2025, 5, 10), "国内販売", Decimal("1_000_000"),
            invoice_number="T0000000000001",
        )
        self.manager.add_export_sale(
            date(2025, 5, 20), "輸出販売", Decimal("500_000"),
        )
        # 仕入（全て課税売上対応）
        self.manager.add_purchase(
            date(2025, 5, 5), "原材料仕入", Decimal("400_000"),
            invoice_number="T9999999999999",
            purchase_usage=PurchaseUsage.TAXABLE_ONLY,
        )

        result = self.manager.calculate_tax_return()
        # 課税売上割合 = (1,000,000 + 500,000) / 1,500,000 = 100%
        assert result.taxable_sales_ratio == Decimal("1.0000")
        # 全額控除
        assert "全額控除" in result.credit_method
        # 400,000 × 7.8% = 31,200（全額）
        assert result.input_tax_credit == Decimal("31200")

    def test_report_output(self):
        self.manager.add_domestic_sale(
            date(2025, 5, 1), "販売", Decimal("500000"),
            invoice_number="T0000000000001",
        )
        report = self.manager.print_tax_return_report()
        assert "消費税申告書サマリー" in report
        assert "合計納付税額" in report

    def test_csv_export(self):
        self.manager.add_domestic_sale(
            date(2025, 5, 1), "商品販売", Decimal("100000"),
        )
        csv_str = self.manager.export_transactions_csv()
        assert "取引日" in csv_str
        assert "商品販売" in csv_str

    def test_date_range_filter(self):
        self.manager.add_domestic_sale(date(2025, 4, 30), "4月売上", Decimal("100000"))
        self.manager.add_domestic_sale(date(2025, 5, 1), "5月売上", Decimal("200000"))
        self.manager.add_domestic_sale(date(2025, 5, 31), "5月末売上", Decimal("300000"))
        self.manager.add_domestic_sale(date(2025, 6, 1), "6月売上", Decimal("400000"))

        may_txs = self.manager.get_transactions(
            start=date(2025, 5, 1), end=date(2025, 5, 31)
        )
        assert len(may_txs) == 2

    def test_net_tax_payable_calculation(self):
        """売上消費税から仕入税額を差し引いた納付額"""
        self.manager.add_domestic_sale(
            date(2025, 5, 1), "販売", Decimal("1_000_000"),
            invoice_number="T0000000000001",
        )
        self.manager.add_purchase(
            date(2025, 5, 2), "仕入", Decimal("300_000"),
            invoice_number="T9999999999999",
            purchase_usage=PurchaseUsage.TAXABLE_ONLY,
        )
        result = self.manager.calculate_tax_return()
        # 売上消費税（国税7.8%）: 1,000,000 × 7.8% = 78,000
        assert result.output_tax == Decimal("78000")
        # 仕入控除: 300,000 × 7.8% = 23,400
        assert result.input_tax_credit == Decimal("23400")
        # 差引国税 = 78,000 - 23,400 = 54,600 → 100円未満切捨て = 54,600
        assert result.net_tax_payable == Decimal("54600")
